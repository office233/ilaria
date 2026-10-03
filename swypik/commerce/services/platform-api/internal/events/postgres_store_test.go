package events

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresStoreAppendPersistsEventsToOutbox(t *testing.T) {
	db := &recordingDB{}
	store := newPostgresStore(db)
	occurredAt := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	err := store.Append(context.Background(), []Event{{
		ID:          "evt_test",
		Type:        "video_progress",
		ActorID:     "11111111-1111-4111-8111-111111111111",
		SessionID:   "session_1",
		SubjectType: "video",
		SubjectID:   "22222222-2222-4222-8222-222222222222",
		VideoID:     "22222222-2222-4222-8222-222222222222",
		ProductID:   "33333333-3333-4333-8333-333333333333",
		OccurredAt:  occurredAt,
		Metadata:    map[string]any{"source": "test"},
	}})
	if err != nil {
		t.Fatalf("expected append, got %v", err)
	}

	exec := db.onlyExec(t)
	for _, want := range []string{"INSERT INTO event_outbox", "stream_name", "event_type", "aggregate_type", "aggregate_id", "payload"} {
		if !strings.Contains(exec.sql, want) {
			t.Fatalf("expected SQL to contain %q:\n%s", want, exec.sql)
		}
	}
	if exec.args[0] != defaultEventStreamName {
		t.Fatalf("expected default stream name, got %#v", exec.args[0])
	}
	if exec.args[1] != "video_progress" {
		t.Fatalf("expected event type, got %#v", exec.args[1])
	}
	if exec.args[2] != "video" {
		t.Fatalf("expected aggregate type, got %#v", exec.args[2])
	}
}

func TestPostgresStoreAppendAllowsNonUUIDSubjects(t *testing.T) {
	db := &recordingDB{}
	store := newPostgresStore(db)

	err := store.Append(context.Background(), []Event{{
		ID:          "evt_non_uuid",
		Type:        "product_click",
		SubjectType: "product",
		SubjectID:   "product_123",
		OccurredAt:  time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC),
	}})
	if err != nil {
		t.Fatalf("expected append with non-uuid subject, got %v", err)
	}

	exec := db.onlyExec(t)
	if exec.args[3] != "" {
		t.Fatalf("expected non-uuid aggregate_id to be stored as null arg, got %#v", exec.args[3])
	}
}

func TestRedisPublisherPublishesJSONBatch(t *testing.T) {
	client := &recordingRedisClient{}
	publisher := NewRedisPublisher(client, "social.events")

	err := publisher.Publish(context.Background(), []Event{{
		ID:          "evt_test",
		Type:        "video_progress",
		SubjectType: "video",
		SubjectID:   "video_1",
	}})
	if err != nil {
		t.Fatalf("expected publish, got %v", err)
	}
	if client.stream != "social.events" {
		t.Fatalf("expected stream social.events, got %q", client.stream)
	}
	if !strings.Contains(string(client.data), `"video_progress"`) {
		t.Fatalf("expected JSON event payload, got %s", string(client.data))
	}
}

type recordedExec struct {
	sql  string
	args []any
}

type recordingDB struct {
	execs []recordedExec
}

func (db *recordingDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execs = append(db.execs, recordedExec{sql: sql, args: append([]any(nil), args...)})
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (db *recordingDB) onlyExec(t *testing.T) recordedExec {
	t.Helper()
	if len(db.execs) != 1 {
		t.Fatalf("expected one exec, got %d", len(db.execs))
	}
	return db.execs[0]
}

type recordingRedisClient struct {
	stream string
	data   []byte
}

func (c *recordingRedisClient) Enabled() bool              { return true }
func (c *recordingRedisClient) Ping(context.Context) error { return nil }
func (c *recordingRedisClient) Publish(_ context.Context, stream string, data []byte) error {
	c.stream = stream
	c.data = append([]byte(nil), data...)
	return nil
}
