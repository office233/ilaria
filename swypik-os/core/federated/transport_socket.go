package federated

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const PilotFrameBytes = 256 << 10

// BootstrapMembership is explicitly operator-pinned, not remote self-enrollment.
type BootstrapMember struct {
	ID        string
	Endpoint  string
	PublicKey ed25519.PublicKey
	Role      string
}
type SocketConfig struct {
	LocalID      string
	PrivateKey   ed25519.PrivateKey
	Members      []BootstrapMember
	Timeout      time.Duration
	TrafficBytes uint64
}
type SocketTransport struct {
	mesh           *TransportMesh
	config         SocketConfig
	listener       net.Listener
	mu             sync.Mutex
	connections    map[*SocketSession]bool
	challenges     map[string]bool
	pending        map[string]bool
	confirmedOrder []string
	closed         bool
	sent, received atomic.Uint64
}
type SocketSession struct {
	transport        *SocketTransport
	conn             net.Conn
	reader           *bufio.Reader
	Peer             BootstrapMember
	authenticated    BootstrapMember
	session          string
	sendSeq, recvSeq uint64
	sendMu, recvMu   sync.Mutex
}
type handshake struct {
	Version   int    `json:"version"`
	Peer      string `json:"peer"`
	Endpoint  string `json:"endpoint"`
	Challenge string `json:"challenge"`
	Remote    string `json:"remote"`
	Signature string `json:"signature"`
}
type socketFrame struct {
	Session   string          `json:"session"`
	Sequence  uint64          `json:"sequence"`
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"`
}

func canonical(v any) []byte { b, _ := json.Marshal(v); return b }
func fresh() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func (tm *TransportMesh) ConfigureSocket(config SocketConfig) (*SocketTransport, error) {
	if config.LocalID != tm.localID || len(config.PrivateKey) != ed25519.PrivateKeySize || config.Timeout <= 0 || config.TrafficBytes < PilotFrameBytes {
		return nil, errors.New("explicit socket identity/key/deadline/traffic required")
	}
	if len(config.Members) < 2 || len(config.Members) > tm.maxPeers {
		return nil, errors.New("bootstrap peer bound")
	}
	ids, keys, endpoints := map[string]bool{}, map[string]bool{}, map[string]bool{}
	local := false
	for _, m := range config.Members {
		host, _, e := net.SplitHostPort(m.Endpoint)
		ip := net.ParseIP(host)
		if e != nil || ip == nil || !ip.IsLoopback() || m.ID == "" || len(m.PublicKey) != 32 || (m.Role != "issuer" && m.Role != "worker") || ids[m.ID] || keys[string(m.PublicKey)] || endpoints[m.Endpoint] {
			return nil, errors.New("invalid/aliased pinned loopback membership")
		}
		ids[m.ID] = true
		keys[string(m.PublicKey)] = true
		endpoints[m.Endpoint] = true
		if m.ID == config.LocalID {
			local = bytes.Equal(m.PublicKey, config.PrivateKey.Public().(ed25519.PublicKey))
		}
	}
	if !local {
		return nil, errors.New("local key is not operator pinned")
	}
	// Copy pins; never allow caller mutation or RegisterPeer to rotate authority.
	config.PrivateKey = append(ed25519.PrivateKey(nil), config.PrivateKey...)
	members := make([]BootstrapMember, len(config.Members))
	copy(members, config.Members)
	for i := range members {
		members[i].PublicKey = append(ed25519.PublicKey(nil), members[i].PublicKey...)
	}
	config.Members = members
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if tm.socket != nil {
		return nil, errors.New("membership already admitted; rotation requires new explicit authority session")
	}
	s := &SocketTransport{mesh: tm, config: config, connections: map[*SocketSession]bool{}, challenges: map[string]bool{}, pending: map[string]bool{}}
	tm.socket = s
	return s, nil
}
func (s *SocketTransport) member(id string) (BootstrapMember, error) {
	for _, m := range s.config.Members {
		if m.ID == id {
			m.PublicKey = append(ed25519.PublicKey(nil), m.PublicKey...)
			return m, nil
		}
	}
	return BootstrapMember{}, errors.New("unknown pinned peer")
}
func (s *SocketTransport) Listen() error {
	m, _ := s.member(s.config.LocalID)
	l, e := net.Listen("tcp", m.Endpoint)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		l.Close()
		return errors.New("closed")
	}
	s.listener = l
	return nil
}
func (s *SocketTransport) Accept(ctx context.Context) (*SocketSession, error) {
	s.mu.Lock()
	l := s.listener
	s.mu.Unlock()
	if l == nil {
		return nil, errors.New("listener not configured")
	}
	stop := context.AfterFunc(ctx, func() { l.Close() })
	defer stop()
	if tcp, ok := l.(*net.TCPListener); ok {
		_ = tcp.SetDeadline(deadline(ctx, s.config.Timeout))
	}
	conn, e := l.Accept()
	if e != nil {
		return nil, e
	}
	return s.authenticate(ctx, conn, "")
}
func (s *SocketTransport) Dial(ctx context.Context, peerID string) (*SocketSession, error) {
	m, e := s.member(peerID)
	if e != nil {
		return nil, e
	}
	d := net.Dialer{Timeout: s.config.Timeout}
	c, e := d.DialContext(ctx, "tcp", m.Endpoint)
	if e != nil {
		return nil, e
	}
	return s.authenticate(ctx, c, peerID)
}
func deadline(ctx context.Context, timeout time.Duration) time.Time {
	d := time.Now().Add(timeout)
	if limit, ok := ctx.Deadline(); ok && limit.Before(d) {
		return limit
	}
	return d
}
func readBounded(reader *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		fragment, e := reader.ReadSlice('\n')
		if len(out)+len(fragment) > PilotFrameBytes+1 {
			return nil, errors.New("oversize socket frame")
		}
		out = append(out, fragment...)
		if e == nil {
			out = bytes.TrimSuffix(out, []byte("\n"))
			out = bytes.TrimSuffix(out, []byte("\r"))
			if len(out) > PilotFrameBytes {
				return nil, errors.New("oversize socket frame")
			}
			return out, nil
		}
		if e != bufio.ErrBufferFull {
			return nil, fmt.Errorf("unterminated socket frame: %w", e)
		}
	}
}
func strict(raw []byte, out any) error {
	// Parse tokens recursively to reject duplicate JSON object keys/trailing values.
	d := json.NewDecoder(bytes.NewReader(raw))
	var walk func() error
	walk = func() error {
		t, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		if delim == '{' {
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return e
				}
				key, ok := k.(string)
				if !ok || seen[key] {
					return errors.New("duplicate socket JSON key")
				}
				seen[key] = true
				if e = walk(); e != nil {
					return e
				}
			}
		} else if delim == '[' {
			for d.More() {
				if e := walk(); e != nil {
					return e
				}
			}
		} else {
			return errors.New("invalid JSON delimiter")
		}
		_, e = d.Token()
		return e
	}
	if e := walk(); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	typed := json.NewDecoder(bytes.NewReader(raw))
	typed.DisallowUnknownFields()
	return typed.Decode(out)
}
func (s *SocketTransport) count(counter *atomic.Uint64, n int) error {
	if counter.Add(uint64(n)) > s.config.TrafficBytes {
		return errors.New("socket traffic budget exhausted")
	}
	return nil
}
func (s *SocketTransport) write(ctx context.Context, c net.Conn, v any) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	raw := canonical(v)
	if len(raw) > PilotFrameBytes {
		return errors.New("serialized socket frame exceeds cap")
	}
	if e := s.count(&s.sent, len(raw)+1); e != nil {
		return e
	}
	_ = c.SetWriteDeadline(deadline(ctx, s.config.Timeout))
	raw = append(raw, '\n')
	for len(raw) > 0 {
		n, e := c.Write(raw)
		if e != nil {
			return e
		}
		raw = raw[n:]
	}
	return nil
}
func (s *SocketTransport) read(ctx context.Context, c net.Conn, r *bufio.Reader, out any) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	_ = c.SetReadDeadline(deadline(ctx, s.config.Timeout))
	raw, e := readBounded(r)
	if e != nil {
		return e
	}
	if e = s.count(&s.received, len(raw)+1); e != nil {
		return e
	}
	return strict(raw, out)
}
func (s *SocketTransport) authenticate(ctx context.Context, c net.Conn, expected string) (*SocketSession, error) {
	success := false
	defer func() {
		if !success {
			c.Close()
		}
	}()
	r := bufio.NewReaderSize(c, 4096)
	local, _ := s.member(s.config.LocalID)
	own := handshake{Version: 1, Peer: local.ID, Endpoint: local.Endpoint, Challenge: fresh()}
	if e := s.write(ctx, c, own); e != nil {
		return nil, e
	}
	var remote handshake
	if e := s.read(ctx, c, r, &remote); e != nil {
		return nil, e
	}
	member, e := s.member(remote.Peer)
	if e != nil {
		return nil, e
	}
	if remote.Version != 1 || remote.Peer == local.ID || remote.Endpoint != member.Endpoint || len(remote.Challenge) != 64 || remote.Signature != "" || remote.Remote != "" || (expected != "" && remote.Peer != expected) {
		return nil, errors.New("invalid pinned endpoint/handshake")
	}
	s.mu.Lock()
	if s.challenges[remote.Challenge] || s.pending[remote.Challenge] || len(s.connections)+len(s.pending) >= s.mesh.maxPeers {
		s.mu.Unlock()
		return nil, errors.New("replayed handshake/admission bound")
	}
	s.pending[remote.Challenge] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, remote.Challenge); s.mu.Unlock() }()
	own.Remote = remote.Challenge
	own.Signature = hex.EncodeToString(ed25519.Sign(s.config.PrivateKey, canonical(own)))
	if e = s.write(ctx, c, own); e != nil {
		return nil, e
	}
	var proof handshake
	if e = s.read(ctx, c, r, &proof); e != nil {
		return nil, e
	}
	sig, e := hex.DecodeString(proof.Signature)
	if e != nil {
		return nil, e
	}
	proof.Signature = ""
	if proof.Version != remote.Version || proof.Peer != remote.Peer || proof.Endpoint != remote.Endpoint || proof.Challenge != remote.Challenge || proof.Remote != own.Challenge || !ed25519.Verify(member.PublicKey, canonical(proof), sig) {
		return nil, errors.New("endpoint challenge authentication failed")
	}
	session := own.Challenge + remote.Challenge
	if own.Peer > remote.Peer {
		session = remote.Challenge + own.Challenge
	}
	authenticated := member
	authenticated.PublicKey = append(ed25519.PublicKey(nil), member.PublicKey...)
	result := &SocketSession{transport: s, conn: c, reader: r, Peer: member, authenticated: authenticated, session: digest([]byte(session))}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("closed")
	}
	s.connections[result] = true
	delete(s.pending, remote.Challenge)
	if len(s.confirmedOrder) >= 128 {
		delete(s.challenges, s.confirmedOrder[0])
		s.confirmedOrder = s.confirmedOrder[1:]
	}
	s.challenges[remote.Challenge] = true
	s.confirmedOrder = append(s.confirmedOrder, remote.Challenge)
	s.mu.Unlock()
	s.mesh.RegisterPeer(&PeerNode{NodeID: member.ID, Endpoint: member.Endpoint, NATType: "LOOPBACK_PINNED"})
	success = true
	return result, nil
}
func (s *SocketSession) Send(ctx context.Context, payload json.RawMessage) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if !json.Valid(payload) {
		return errors.New("invalid payload JSON")
	}
	s.sendSeq++
	frame := socketFrame{Session: s.session, Sequence: s.sendSeq, Payload: payload}
	frame.Signature = hex.EncodeToString(ed25519.Sign(s.transport.config.PrivateKey, canonical(frame)))
	if e := s.transport.write(ctx, s.conn, frame); e != nil {
		s.Close()
		return e
	}
	return nil
}
func (s *SocketSession) Receive(ctx context.Context) (json.RawMessage, error) {
	s.recvMu.Lock()
	defer s.recvMu.Unlock()
	var f socketFrame
	if e := s.transport.read(ctx, s.conn, s.reader, &f); e != nil {
		s.Close()
		return nil, e
	}
	sig, e := hex.DecodeString(f.Signature)
	f.Signature = ""
	if e != nil || f.Session != s.session || f.Sequence != s.recvSeq+1 || !ed25519.Verify(s.authenticated.PublicKey, canonical(f), sig) {
		s.Close()
		return nil, errors.New("session/frame replay/authentication")
	}
	s.recvSeq = f.Sequence
	return f.Payload, nil
}

// AuthenticatedPeer returns an independent metadata snapshot, never auth state.
func (s *SocketSession) AuthenticatedPeer() BootstrapMember {
	p := s.authenticated
	p.PublicKey = append(ed25519.PublicKey(nil), p.PublicKey...)
	return p
}
func (s *SocketSession) Close() error {
	s.transport.mu.Lock()
	delete(s.transport.connections, s)
	s.transport.mu.Unlock()
	return s.conn.Close()
}
func (s *SocketTransport) Bytes() (uint64, uint64) { return s.sent.Load(), s.received.Load() }
func (s *SocketTransport) Close() error {
	s.mu.Lock()
	s.closed = true
	l := s.listener
	connections := make([]*SocketSession, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	for _, c := range connections {
		c.Close()
	}
	if l != nil {
		return l.Close()
	}
	return nil
}
func (s *SocketTransport) String() string { return fmt.Sprintf("pinned-loopback:%s", s.config.LocalID) }
