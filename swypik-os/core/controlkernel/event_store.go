package controlkernel

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	ErrClosed              = errors.New("control-kernel store is closed")
	ErrCorruptJournal      = errors.New("control-kernel journal is corrupt")
	ErrSequenceMismatch    = errors.New("event stream sequence mismatch")
	ErrStorageFailed       = errors.New("control-kernel storage failed closed")
	ErrInvalidTransition   = errors.New("invalid node state transition")
	ErrNotFound            = errors.New("control-kernel entity not found")
	ErrConflict            = errors.New("control-kernel entity conflict")
	ErrLeaseExpired        = errors.New("lease expired")
	ErrStaleLease          = errors.New("stale or mismatched lease fence")
	ErrIdempotencyConflict = errors.New("idempotency key reused for different intent")
	ErrInvalidIntentState  = errors.New("invalid intent state transition")
)

const (
	journalMagic   = "SWCKJNL1"
	journalVersion = 1
	frameHeaderLen = 12
	frameHashLen   = sha256.Size
	maxFrameBytes  = 16 << 20
)

var frameMagic = [4]byte{'C', 'K', 'F', '1'}

type journalBatch struct {
	Version int     `json:"version"`
	Events  []Event `json:"events"`
}

type eventHashInput struct {
	ID         string          `json:"id"`
	Stream     string          `json:"stream"`
	Seq        uint64          `json:"seq"`
	JournalSeq uint64          `json:"journal_seq"`
	Type       string          `json:"type"`
	At         time.Time       `json:"at"`
	Data       json.RawMessage `json:"data"`
	PrevHash   string          `json:"prev_hash,omitempty"`
}

// EventStore is a single-writer durable append-only journal. The writer lock is
// held for the lifetime of the store so expected-sequence CAS cannot be bypassed
// by a second cooperating process.
type EventStore struct {
	mu        sync.Mutex
	path      string
	file      *os.File
	lock      *os.File
	closed    bool
	failed    error
	streamSeq map[string]uint64
	journal   uint64
	headHash  string
	events    []Event
}

// OpenEventStore opens or creates a journal. Only a physically incomplete last
// frame is repaired by truncating it. Any complete frame with a bad checksum,
// sequence, JSON body, version, or hash-chain fails closed.
func OpenEventStore(path string) (*EventStore, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, fmt.Errorf("journal path must be absolute")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("journal parent must be a real directory")
	}
	lock, err := acquireJournalLock(path + ".lock")
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	if info, statErr := f.Stat(); statErr != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		_ = lock.Close()
		if statErr != nil {
			return nil, statErr
		}
		return nil, fmt.Errorf("journal must be a regular file")
	}
	s := &EventStore{
		path:      path,
		file:      f,
		lock:      lock,
		streamSeq: make(map[string]uint64),
	}
	if err := s.loadAndRepairTail(); err != nil {
		_ = f.Close()
		_ = lock.Close()
		return nil, err
	}
	return s, nil
}

func (s *EventStore) loadAndRepairTail() error {
	info, err := s.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		if _, err := s.file.Write([]byte(journalMagic)); err != nil {
			return err
		}
		if err := s.file.Sync(); err != nil {
			return err
		}
		_, err = s.file.Seek(0, io.SeekEnd)
		return err
	}
	if info.Size() < int64(len(journalMagic)) {
		return fmt.Errorf("%w: partial journal header", ErrCorruptJournal)
	}
	if _, err := s.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	header := make([]byte, len(journalMagic))
	if _, err := io.ReadFull(s.file, header); err != nil {
		return err
	}
	if string(header) != journalMagic {
		return fmt.Errorf("%w: bad journal magic", ErrCorruptJournal)
	}

	offset := int64(len(journalMagic))
	for offset < info.Size() {
		remaining := info.Size() - offset
		if remaining < frameHeaderLen {
			return s.truncateTornTail(offset)
		}
		frameHeader := make([]byte, frameHeaderLen)
		if _, err := io.ReadFull(s.file, frameHeader); err != nil {
			return err
		}
		if !bytes.Equal(frameHeader[:4], frameMagic[:]) {
			return fmt.Errorf("%w at offset %d: bad frame magic", ErrCorruptJournal, offset)
		}
		bodyLenRaw := binary.LittleEndian.Uint32(frameHeader[4:8])
		bodyLenCheck := binary.LittleEndian.Uint32(frameHeader[8:12])
		if bodyLenCheck != ^bodyLenRaw {
			return fmt.Errorf("%w at offset %d: corrupt frame length header", ErrCorruptJournal, offset)
		}
		bodyLen := int64(bodyLenRaw)
		if bodyLen <= 0 || bodyLen > maxFrameBytes {
			return fmt.Errorf("%w at offset %d: invalid frame length %d", ErrCorruptJournal, offset, bodyLen)
		}
		frameLen := int64(frameHeaderLen) + bodyLen + frameHashLen
		if remaining < frameLen {
			return s.truncateTornTail(offset)
		}
		body := make([]byte, bodyLen)
		if _, err := io.ReadFull(s.file, body); err != nil {
			return err
		}
		storedHash := make([]byte, frameHashLen)
		if _, err := io.ReadFull(s.file, storedHash); err != nil {
			return err
		}
		digest := sha256.Sum256(body)
		if !bytes.Equal(storedHash, digest[:]) {
			return fmt.Errorf("%w at offset %d: frame checksum mismatch", ErrCorruptJournal, offset)
		}
		if err := s.applyBatchBody(body, offset); err != nil {
			return err
		}
		offset += frameLen
	}
	_, err = s.file.Seek(0, io.SeekEnd)
	return err
}

func (s *EventStore) truncateTornTail(offset int64) error {
	if err := s.file.Truncate(offset); err != nil {
		return err
	}
	if err := s.file.Sync(); err != nil {
		return err
	}
	_, err := s.file.Seek(offset, io.SeekStart)
	return err
}

func (s *EventStore) applyBatchBody(body []byte, offset int64) error {
	var batch journalBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		return fmt.Errorf("%w at offset %d: decode batch: %v", ErrCorruptJournal, offset, err)
	}
	if batch.Version != journalVersion || len(batch.Events) == 0 {
		return fmt.Errorf("%w at offset %d: unsupported/empty batch", ErrCorruptJournal, offset)
	}

	tempSeq := make(map[string]uint64, len(s.streamSeq))
	for stream, seq := range s.streamSeq {
		tempSeq[stream] = seq
	}
	tempJournal := s.journal
	tempHead := s.headHash
	for _, event := range batch.Events {
		if event.Stream == "" || event.Type == "" || event.ID == "" || event.Hash == "" {
			return fmt.Errorf("%w at offset %d: incomplete event metadata", ErrCorruptJournal, offset)
		}
		if event.Seq != tempSeq[event.Stream]+1 {
			return fmt.Errorf("%w at offset %d: stream %q sequence %d after %d", ErrCorruptJournal, offset, event.Stream, event.Seq, tempSeq[event.Stream])
		}
		if event.JournalSeq != tempJournal+1 {
			return fmt.Errorf("%w at offset %d: journal sequence %d after %d", ErrCorruptJournal, offset, event.JournalSeq, tempJournal)
		}
		if event.PrevHash != tempHead {
			return fmt.Errorf("%w at offset %d: hash-chain predecessor mismatch", ErrCorruptJournal, offset)
		}
		hash, err := computeEventHash(event)
		if err != nil || hash != event.Hash {
			return fmt.Errorf("%w at offset %d: event hash mismatch", ErrCorruptJournal, offset)
		}
		if len(event.Data) == 0 || !json.Valid(event.Data) {
			return fmt.Errorf("%w at offset %d: invalid event data", ErrCorruptJournal, offset)
		}
		tempSeq[event.Stream] = event.Seq
		tempJournal = event.JournalSeq
		tempHead = event.Hash
	}

	s.streamSeq = tempSeq
	s.journal = tempJournal
	s.headHash = tempHead
	s.events = append(s.events, cloneEvents(batch.Events)...)
	return nil
}

// Append performs an expected-sequence compare-and-swap and persists all
// supplied events in one checksummed frame followed by fsync. A crash can leave
// either the complete batch or an incomplete final frame; replay never accepts
// a prefix of a batch.
func (s *EventStore) Append(stream string, expectedSeq uint64, events ...Event) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	if s.failed != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageFailed, s.failed)
	}
	if stream == "" || len(events) == 0 {
		return nil, fmt.Errorf("stream and events are required")
	}
	actual := s.streamSeq[stream]
	if actual != expectedSeq {
		return nil, fmt.Errorf("%w: stream %q expected %d, actual %d", ErrSequenceMismatch, stream, expectedSeq, actual)
	}

	now := time.Now().UTC()
	prepared := make([]Event, len(events))
	head := s.headHash
	journalSeq := s.journal
	seq := actual
	for i, input := range events {
		if input.Type == "" {
			return nil, fmt.Errorf("event %d has empty type", i)
		}
		if len(input.Data) == 0 {
			input.Data = json.RawMessage(`{}`)
		}
		if !json.Valid(input.Data) {
			return nil, fmt.Errorf("event %d data is not valid JSON", i)
		}
		if input.ID == "" {
			id, err := randomID()
			if err != nil {
				return nil, err
			}
			input.ID = id
		}
		if input.At.IsZero() {
			input.At = now
		} else {
			input.At = input.At.UTC()
		}
		seq++
		journalSeq++
		input.Stream = stream
		input.Seq = seq
		input.JournalSeq = journalSeq
		input.PrevHash = head
		input.Hash = ""
		hash, err := computeEventHash(input)
		if err != nil {
			return nil, err
		}
		input.Hash = hash
		head = hash
		prepared[i] = input
	}

	body, err := json.Marshal(journalBatch{Version: journalVersion, Events: prepared})
	if err != nil {
		return nil, err
	}
	if len(body) > maxFrameBytes {
		return nil, fmt.Errorf("event batch exceeds %d bytes", maxFrameBytes)
	}
	frame := encodeFrame(body)
	if _, err := s.file.Seek(0, io.SeekEnd); err != nil {
		s.failed = err
		return nil, fmt.Errorf("%w: %v", ErrStorageFailed, err)
	}
	n, err := s.file.Write(frame)
	if err == nil && n != len(frame) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = s.file.Sync()
	}
	if err != nil {
		s.failed = err
		return nil, fmt.Errorf("%w: %v", ErrStorageFailed, err)
	}

	s.streamSeq[stream] = seq
	s.journal = journalSeq
	s.headHash = head
	s.events = append(s.events, cloneEvents(prepared)...)
	return cloneEvents(prepared), nil
}

func encodeFrame(body []byte) []byte {
	frame := make([]byte, frameHeaderLen+len(body)+frameHashLen)
	copy(frame[:4], frameMagic[:])
	binary.LittleEndian.PutUint32(frame[4:8], uint32(len(body)))
	binary.LittleEndian.PutUint32(frame[8:12], ^uint32(len(body)))
	copy(frame[frameHeaderLen:], body)
	digest := sha256.Sum256(body)
	copy(frame[frameHeaderLen+len(body):], digest[:])
	return frame
}

func computeEventHash(event Event) (string, error) {
	raw, err := json.Marshal(eventHashInput{
		ID:         event.ID,
		Stream:     event.Stream,
		Seq:        event.Seq,
		JournalSeq: event.JournalSeq,
		Type:       event.Type,
		At:         event.At.UTC(),
		Data:       event.Data,
		PrevHash:   event.PrevHash,
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func randomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func cloneEvents(events []Event) []Event {
	out := make([]Event, len(events))
	for i, event := range events {
		out[i] = event
		out[i].Data = append(json.RawMessage(nil), event.Data...)
	}
	return out
}

// Sequence returns the last committed sequence for a stream.
func (s *EventStore) Sequence(stream string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streamSeq[stream]
}

// Events returns an immutable copy in journal order for projection replay.
func (s *EventStore) Events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneEvents(s.events)
}

func (s *EventStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return errors.Join(s.file.Close(), s.lock.Close())
}
