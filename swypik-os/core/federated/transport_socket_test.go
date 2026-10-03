package federated

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func freeEndpoint(t *testing.T) string {
	t.Helper()
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	address := l.Addr().String()
	l.Close()
	return address
}
func TestActualPinnedSocketDeliveryAndUnknownAdmission(t *testing.T) {
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, bk, _ := ed25519.GenerateKey(rand.Reader)
	members := []BootstrapMember{{ID: "issuer", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "worker", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}
	a, e := NewTransportMesh("issuer", "synthetic-cpu").ConfigureSocket(SocketConfig{LocalID: "issuer", PrivateKey: ak, Members: members, Timeout: time.Second, TrafficBytes: 1 << 20})
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := NewTransportMesh("worker", "synthetic-cpu").ConfigureSocket(SocketConfig{LocalID: "worker", PrivateKey: bk, Members: members, Timeout: time.Second, TrafficBytes: 1 << 20})
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	if e = a.Listen(); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	server := make(chan *SocketSession, 1)
	failure := make(chan error, 1)
	go func() {
		c, e := a.Accept(ctx)
		if e != nil {
			failure <- e
		} else {
			server <- c
		}
	}()
	client, e := b.Dial(ctx, "issuer")
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	var accepted *SocketSession
	select {
	case accepted = <-server:
	case e := <-failure:
		t.Fatal(e)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	defer accepted.Close()
	if e = client.Send(ctx, json.RawMessage(`{"public_synthetic":true}`)); e != nil {
		t.Fatal(e)
	}
	received, e := accepted.Receive(ctx)
	if e != nil || string(received) != `{"public_synthetic":true}` {
		t.Fatalf("actual delivery %s %v", received, e)
	}
	sent, recv := a.Bytes()
	if sent == 0 || recv == 0 {
		t.Fatal("socket traffic absent")
	}
	if _, e = b.Dial(ctx, "unknown"); e == nil {
		t.Fatal("unknown peer")
	}
	alias := append([]BootstrapMember(nil), members...)
	alias[1].PublicKey = ap
	if _, e = NewTransportMesh("issuer", "cpu").ConfigureSocket(SocketConfig{LocalID: "issuer", PrivateKey: ak, Members: alias, Timeout: time.Second, TrafficBytes: 1 << 20}); e == nil {
		t.Fatal("key alias admission")
	}
	validOversize := json.RawMessage(`{"data":"` + strings.Repeat("x", PilotFrameBytes) + `"}`)
	if !json.Valid(validOversize) {
		t.Fatal("oversize fixture must be valid JSON")
	}
	if e = client.Send(ctx, validOversize); e == nil {
		t.Fatal("oversize serialized valid frame accepted")
	}
}
func TestSocketEOFAndCancellation(t *testing.T) {
	if _, e := readBounded(bufio.NewReader(strings.NewReader(`{"valid":true}`))); e == nil {
		t.Fatal("EOF without LF accepted")
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	s := &SocketTransport{config: SocketConfig{Timeout: time.Minute, TrafficBytes: 1 << 20}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { var h handshake; done <- s.read(ctx, a, bufio.NewReader(a), &h) }()
	cancel()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancel accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not close IO")
	}
}

func TestSocketValidFrameOverheadBackpressureAndReplay(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	s := &SocketTransport{config: SocketConfig{Timeout: time.Second, TrafficBytes: 1 << 20}}
	// Payload itself fits cap; signature/session/frame overhead makes serialized
	// frame invalid. Refusal must happen without touching a network writer.
	frame := socketFrame{Session: strings.Repeat("s", 64), Sequence: 1, Payload: json.RawMessage(`"` + strings.Repeat("x", PilotFrameBytes-2) + `"`), Signature: strings.Repeat("0", 128)}
	if e := s.write(context.Background(), a, frame); e == nil {
		t.Fatal("wire overhead ignored")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if e := s.write(ctx, a, map[string]string{"bounded": "blocked writer"}); e == nil {
		t.Fatal("backpressure failed")
	}
}

func TestReplayedHandshakeRejectedBeforeWork(t *testing.T) {
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, _, _ := ed25519.GenerateKey(rand.Reader)
	config := SocketConfig{LocalID: "issuer", PrivateKey: ak, Timeout: time.Second, TrafficBytes: 1 << 20, Members: []BootstrapMember{{ID: "issuer", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "worker", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}}
	transport, e := NewTransportMesh("issuer", "cpu").ConfigureSocket(config)
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	challenge := strings.Repeat("a", 64)
	transport.challenges[challenge] = true
	a, b := net.Pipe()
	defer b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		session, e := transport.authenticate(ctx, a, "")
		if session != nil {
			session.Close()
		}
		result <- e
	}()
	reader := bufio.NewReader(b)
	if _, e = readBounded(reader); e != nil {
		t.Fatal(e)
	}
	hello := handshake{Version: 1, Peer: "worker", Endpoint: config.Members[1].Endpoint, Challenge: challenge}
	if _, e = b.Write(append(canonical(hello), '\n')); e != nil {
		t.Fatal(e)
	}
	if e = <-result; e == nil {
		t.Fatal("replayed endpoint handshake accepted")
	}
	if len(transport.mesh.GetPeers()) != 0 {
		t.Fatal("unauthed peer registered")
	}
}

func TestReviewF1FailedAdmissionDoesNotConsumeReplay(t *testing.T) {
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, _, _ := ed25519.GenerateKey(rand.Reader)
	config := SocketConfig{LocalID: "issuer", PrivateKey: ak, Timeout: time.Second, TrafficBytes: 4 << 20, Members: []BootstrapMember{{ID: "issuer", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "worker", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}}
	transport, e := NewTransportMesh("issuer", "cpu").ConfigureSocket(config)
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	for i := 0; i < 129; i++ {
		a, b := net.Pipe()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		done := make(chan error, 1)
		go func() {
			s, e := transport.authenticate(ctx, a, "")
			if s != nil {
				s.Close()
			}
			done <- e
		}()
		reader := bufio.NewReader(b)
		if _, e = readBounded(reader); e != nil {
			t.Fatal(e)
		}
		hello := handshake{Version: 1, Peer: "worker", Endpoint: config.Members[1].Endpoint, Challenge: fresh()}
		_, _ = b.Write(append(canonical(hello), '\n'))
		_, _ = readBounded(reader)
		b.Close()
		<-done
		cancel()
	}
	if len(transport.challenges) != 0 {
		t.Fatalf("F1 unauthenticated attempts permanently retained %d challenges", len(transport.challenges))
	}
}

func TestReviewF4ReturnedPeerCannotMutatePins(t *testing.T) {
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, _, _ := ed25519.GenerateKey(rand.Reader)
	config := SocketConfig{LocalID: "issuer", PrivateKey: ak, Timeout: time.Second, TrafficBytes: 1 << 20, Members: []BootstrapMember{{ID: "issuer", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "worker", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}}
	transport, e := NewTransportMesh("issuer", "cpu").ConfigureSocket(config)
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	returned, _ := transport.member("worker")
	returned.PublicKey[0] ^= 255
	pinned, _ := transport.member("worker")
	if !bytes.Equal(pinned.PublicKey, bp) {
		t.Fatal("F4 returned member aliases authenticated pin")
	}
}

func TestReviewLegitimateReconnect129AndPrivateAuthentication(t *testing.T) {
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, bk, _ := ed25519.GenerateKey(rand.Reader)
	pins := []BootstrapMember{{ID: "issuer", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "worker", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}
	a, e := NewTransportMesh("issuer", "cpu").ConfigureSocket(SocketConfig{LocalID: "issuer", PrivateKey: ak, Members: pins, Timeout: time.Second, TrafficBytes: 4 << 20})
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := NewTransportMesh("worker", "cpu").ConfigureSocket(SocketConfig{LocalID: "worker", PrivateKey: bk, Members: pins, Timeout: time.Second, TrafficBytes: 4 << 20})
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	if e = a.Listen(); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 129; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		got := make(chan *SocketSession, 1)
		failed := make(chan error, 1)
		go func() {
			s, e := a.Accept(ctx)
			if e != nil {
				failed <- e
			} else {
				got <- s
			}
		}()
		client, e := b.Dial(ctx, "issuer")
		if e != nil {
			t.Fatal("legitimate reconnect", i, e)
		}
		var server *SocketSession
		select {
		case server = <-got:
		case e = <-failed:
			t.Fatal(e)
		}
		server.Peer.PublicKey = make([]byte, 32)
		copyPeer := server.AuthenticatedPeer()
		copyPeer.PublicKey[0] ^= 255
		sent := make(chan error, 1)
		go func() { sent <- client.Send(ctx, json.RawMessage(`{"verified":true}`)) }()
		if _, e = server.Receive(ctx); e != nil {
			t.Fatal("metadata changed authentication", e)
		}
		if e = <-sent; e != nil {
			t.Fatal(e)
		}
		server.Close()
		client.Close()
		cancel()
	}
	if len(a.challenges) > 128 || len(a.pending) != 0 {
		t.Fatal("replay/admission ledger unbounded")
	}
}
func TestSocketStrictDuplicateTrailingAndPinRotation(t *testing.T) {
	for _, raw := range []string{`{"peer":"a","peer":"b"}`, `{} {}`, `{"unknown":1}`} {
		var h handshake
		if strict([]byte(raw), &h) == nil {
			t.Fatal("invalid handshake JSON", raw)
		}
	}
	ap, ak, _ := ed25519.GenerateKey(rand.Reader)
	bp, _, _ := ed25519.GenerateKey(rand.Reader)
	mesh := NewTransportMesh("a", "cpu")
	config := SocketConfig{LocalID: "a", PrivateKey: ak, Timeout: time.Second, TrafficBytes: 1 << 20, Members: []BootstrapMember{{ID: "a", Endpoint: freeEndpoint(t), PublicKey: ap, Role: "issuer"}, {ID: "b", Endpoint: freeEndpoint(t), PublicKey: bp, Role: "worker"}}}
	s, e := mesh.ConfigureSocket(config)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if _, e = mesh.ConfigureSocket(config); e == nil {
		t.Fatal("implicit key/member rotation")
	}
}
