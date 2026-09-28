package events

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestRecordBatchNormalizesFrontendBatchPayload(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	publisher := NewMemoryPublisher()
	service := NewService(store, publisher)
	service.clock = func() time.Time {
		return time.Date(2026, 5, 10, 13, 0, 0, 0, time.UTC)
	}
	batch := decodeBatch(t, `{
		"session_id": "session_1",
		"events": [
			{
				"type": "video_progress",
				"video_id": "video_1",
				"product_id": "product_1",
				"watch_ms": 1200,
				"position_ms": 450,
				"metadata": {"source": "next-feed"},
				"timestamp": "2026-05-10T12:34:56Z"
			}
		]
	}`)

	result, err := service.RecordBatch(ctx, batch)
	if err != nil {
		t.Fatalf("expected frontend batch to be accepted, got %v", err)
	}
	if result.Accepted != 1 {
		t.Fatalf("expected one accepted event, got %d", result.Accepted)
	}

	stored := store.Events()
	if len(stored) != 1 {
		t.Fatalf("expected one stored event, got %d", len(stored))
	}
	event := stored[0]
	if event.Type != "video_progress" {
		t.Fatalf("expected type normalized, got %q", event.Type)
	}
	if event.SubjectType != "video" || event.SubjectID != "video_1" {
		t.Fatalf("expected video subject, got %q/%q", event.SubjectType, event.SubjectID)
	}
	expectedOccurredAt := time.Date(2026, 5, 10, 12, 34, 56, 0, time.UTC)
	if !event.OccurredAt.Equal(expectedOccurredAt) {
		t.Fatalf("expected timestamp to become occurred_at, got %s", event.OccurredAt)
	}
	if event.Metadata["source"] != "next-feed" {
		t.Fatalf("expected metadata preserved, got %#v", event.Metadata)
	}

	payload := eventPayload(t, event)
	if payload["session_id"] != "session_1" {
		t.Fatalf("expected session_id persisted, got %#v", payload["session_id"])
	}
	if payload["video_id"] != "video_1" {
		t.Fatalf("expected video_id persisted, got %#v", payload["video_id"])
	}
	if payload["product_id"] != "product_1" {
		t.Fatalf("expected product_id persisted, got %#v", payload["product_id"])
	}
	if payload["watch_ms"] != float64(1200) {
		t.Fatalf("expected watch_ms persisted, got %#v", payload["watch_ms"])
	}
	if payload["position_ms"] != float64(450) {
		t.Fatalf("expected position_ms persisted, got %#v", payload["position_ms"])
	}
}

func TestRecordBatchNormalizesLegacySubjectPayload(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, NewMemoryPublisher())
	service.clock = func() time.Time {
		return time.Date(2026, 5, 10, 13, 0, 0, 0, time.UTC)
	}
	batch := decodeBatch(t, `{
		"session_id": "legacy_session",
		"events": [
			{
				"event_type": "video_viewed",
				"subject_type": "creator",
				"subject_id": "creator_1",
				"metadata": {"source": "legacy-client"},
				"timestamp": "2026-05-10T12:35:56Z"
			}
		]
	}`)

	result, err := service.RecordBatch(ctx, batch)
	if err != nil {
		t.Fatalf("expected legacy subject batch to be accepted, got %v", err)
	}
	if result.Accepted != 1 {
		t.Fatalf("expected one accepted event, got %d", result.Accepted)
	}

	stored := store.Events()
	if len(stored) != 1 {
		t.Fatalf("expected one stored event, got %d", len(stored))
	}
	event := stored[0]
	if event.Type != "video_viewed" {
		t.Fatalf("expected event_type alias to become type, got %q", event.Type)
	}
	if event.SubjectType != "creator" || event.SubjectID != "creator_1" {
		t.Fatalf("expected legacy subject preserved, got %q/%q", event.SubjectType, event.SubjectID)
	}
	expectedOccurredAt := time.Date(2026, 5, 10, 12, 35, 56, 0, time.UTC)
	if !event.OccurredAt.Equal(expectedOccurredAt) {
		t.Fatalf("expected timestamp to become occurred_at, got %s", event.OccurredAt)
	}

	payload := eventPayload(t, event)
	if payload["session_id"] != "legacy_session" {
		t.Fatalf("expected session_id persisted, got %#v", payload["session_id"])
	}
	if _, ok := payload["event_type"]; ok {
		t.Fatalf("expected deprecated event_type to be cleared, got %#v", payload["event_type"])
	}
}

func TestRecordBatchStoresAndPublishesAcceptedEvents(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	publisher := NewMemoryPublisher()
	service := NewService(store, publisher)
	occurredAt := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	result, err := service.RecordBatch(ctx, Batch{
		Events: []Event{
			{
				Type:        "video_view",
				ActorID:     "user_1",
				SubjectType: "video",
				SubjectID:   "video_1",
				OccurredAt:  occurredAt,
				Metadata:    map[string]any{"watch_ms": float64(1200)},
			},
		},
	})
	if err != nil {
		t.Fatalf("expected valid batch, got %v", err)
	}
	if result.Accepted != 1 {
		t.Fatalf("expected one accepted event, got %d", result.Accepted)
	}
	if len(store.Events()) != 1 {
		t.Fatalf("expected event stored, got %d", len(store.Events()))
	}
	if len(publisher.Messages()) != 1 {
		t.Fatalf("expected event published, got %d", len(publisher.Messages()))
	}
	if store.Events()[0].OccurredAt != occurredAt {
		t.Fatalf("expected occurred_at preserved, got %s", store.Events()[0].OccurredAt)
	}
}

func TestRecordBatchRejectsInvalidEvents(t *testing.T) {
	service := NewService(NewMemoryStore(), NewMemoryPublisher())

	_, err := service.RecordBatch(context.Background(), Batch{
		Events: []Event{{SubjectType: "video", SubjectID: "video_1"}},
	})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for missing type, got %v", err)
	}
}

func decodeBatch(t *testing.T, payload string) Batch {
	t.Helper()
	var batch Batch
	if err := json.Unmarshal([]byte(payload), &batch); err != nil {
		t.Fatalf("decode batch: %v", err)
	}
	return batch
}

func eventPayload(t *testing.T, event Event) map[string]any {
	t.Helper()
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	return payload
}
