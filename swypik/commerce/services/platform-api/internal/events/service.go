package events

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var ErrValidation = errors.New("validation failed")

type Event struct {
	ID          string         `json:"id,omitempty"`
	Type        string         `json:"type,omitempty"`
	EventType   string         `json:"event_type,omitempty"`
	ActorID     string         `json:"actor_id,omitempty"`
	SessionID   string         `json:"session_id,omitempty"`
	SubjectType string         `json:"subject_type"`
	SubjectID   string         `json:"subject_id"`
	VideoID     string         `json:"video_id,omitempty"`
	ProductID   string         `json:"product_id,omitempty"`
	WatchMS     *int64         `json:"watch_ms,omitempty"`
	PositionMS  *int64         `json:"position_ms,omitempty"`
	OccurredAt  time.Time      `json:"occurred_at,omitempty"`
	Timestamp   string         `json:"timestamp,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type Batch struct {
	SessionID string  `json:"session_id,omitempty"`
	Events    []Event `json:"events"`
}

type RecordResult struct {
	BatchID  string `json:"batch_id"`
	Accepted int    `json:"accepted"`
	Stored   bool   `json:"stored"`
}

type Store interface {
	Append(context.Context, []Event) error
}

type Publisher interface {
	Publish(context.Context, []Event) error
}

type Service struct {
	store     Store
	publisher Publisher
	clock     func() time.Time
}

func NewService(store Store, publisher Publisher) *Service {
	if store == nil {
		store = NewMemoryStore()
	}
	if publisher == nil {
		publisher = NewMemoryPublisher()
	}
	return &Service{store: store, publisher: publisher, clock: time.Now}
}

func (s *Service) RecordBatch(ctx context.Context, batch Batch) (RecordResult, error) {
	events, err := s.normalize(batch)
	if err != nil {
		return RecordResult{}, err
	}
	if err := s.store.Append(ctx, events); err != nil {
		return RecordResult{}, err
	}
	if err := s.publisher.Publish(ctx, events); err != nil {
		return RecordResult{}, err
	}
	return RecordResult{BatchID: newID("evt_batch"), Accepted: len(events), Stored: true}, nil
}

func (s *Service) normalize(batch Batch) ([]Event, error) {
	if len(batch.Events) == 0 {
		return nil, validationError("events is required")
	}
	if len(batch.Events) > 100 {
		return nil, validationError("events cannot contain more than 100 entries")
	}
	events := make([]Event, len(batch.Events))
	now := s.clock().UTC()
	sessionID := strings.TrimSpace(batch.SessionID)
	for idx, event := range batch.Events {
		event.Type = strings.TrimSpace(firstNonEmpty(event.Type, event.EventType))
		event.EventType = ""
		event.ActorID = strings.TrimSpace(event.ActorID)
		event.SessionID = strings.TrimSpace(firstNonEmpty(event.SessionID, sessionID))
		event.SubjectType = strings.TrimSpace(event.SubjectType)
		event.SubjectID = strings.TrimSpace(event.SubjectID)
		event.VideoID = strings.TrimSpace(event.VideoID)
		event.ProductID = strings.TrimSpace(event.ProductID)
		event.Timestamp = strings.TrimSpace(event.Timestamp)
		normalizeSubject(&event)
		if event.Type == "" {
			return nil, validationError(fmt.Sprintf("events[%d].type is required", idx))
		}
		if event.SubjectType == "" {
			return nil, validationError(fmt.Sprintf("events[%d].subject_type is required", idx))
		}
		if event.SubjectID == "" {
			return nil, validationError(fmt.Sprintf("events[%d].subject_id is required", idx))
		}
		if event.OccurredAt.IsZero() {
			if event.Timestamp != "" {
				occurredAt, err := time.Parse(time.RFC3339Nano, event.Timestamp)
				if err != nil {
					return nil, validationError(fmt.Sprintf("events[%d].timestamp must be RFC3339", idx))
				}
				event.OccurredAt = occurredAt.UTC()
			} else {
				event.OccurredAt = now
			}
		}
		event.Timestamp = ""
		if event.ID == "" {
			event.ID = newID("evt")
		}
		events[idx] = event
	}
	return events, nil
}

func normalizeSubject(event *Event) {
	if event.SubjectType == "" && event.SubjectID == "" {
		switch {
		case event.VideoID != "":
			event.SubjectType = "video"
			event.SubjectID = event.VideoID
		case event.ProductID != "":
			event.SubjectType = "product"
			event.SubjectID = event.ProductID
		}
		return
	}

	if event.SubjectID == "" {
		switch event.SubjectType {
		case "video":
			event.SubjectID = event.VideoID
		case "product":
			event.SubjectID = event.ProductID
		}
	}

	if event.SubjectType == "" {
		switch {
		case event.VideoID != "" && event.SubjectID == event.VideoID:
			event.SubjectType = "video"
		case event.ProductID != "" && event.SubjectID == event.ProductID:
			event.SubjectType = "product"
		}
	}
}

type MemoryStore struct {
	mu     sync.RWMutex
	events []Event
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

func (s *MemoryStore) Append(_ context.Context, events []Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, events...)
	return nil
}

func (s *MemoryStore) Events() []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Event(nil), s.events...)
}

type MemoryPublisher struct {
	mu       sync.RWMutex
	messages [][]Event
}

func NewMemoryPublisher() *MemoryPublisher {
	return &MemoryPublisher{}
}

func (p *MemoryPublisher) Publish(_ context.Context, events []Event) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages = append(p.messages, append([]Event(nil), events...))
	return nil
}

func (p *MemoryPublisher) Messages() [][]Event {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([][]Event, len(p.messages))
	for idx := range p.messages {
		out[idx] = append([]Event(nil), p.messages[idx]...)
	}
	return out
}

func validationError(message string) error {
	return fmt.Errorf("%w: %s", ErrValidation, message)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}
