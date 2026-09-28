package videos

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresStoreCreateUploadPersistsUploadSessionSchema(t *testing.T) {
	db := &recordingPostgresDB{}
	store := newPostgresStore(db)
	expiresAt := time.Date(2026, 5, 10, 12, 15, 0, 0, time.UTC)
	createdAt := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	err := store.CreateUpload(context.Background(), Upload{
		ID:              "upl_test",
		CreatorID:       "11111111-1111-4111-8111-111111111111",
		ProductID:       "product_1",
		Filename:        "clip.mp4",
		ContentType:     "video/mp4",
		SizeBytes:       4096,
		ChecksumSHA:     "sha256:test",
		OriginalName:    "Launch clip",
		StorageProvider: "r2",
		Bucket:          "swypik-video-uploads",
		ObjectKey:       "uploads/creator/upl_test/clip.mp4",
		Status:          UploadUploading,
		UploadURL:       "https://uploads.swypik.test/uploads/creator/upl_test/clip.mp4",
		ExpiresAt:       expiresAt,
		CreatedAt:       createdAt,
	})
	if err != nil {
		t.Fatalf("expected create upload, got %v", err)
	}

	exec := db.onlyExec(t)
	assertSQLContains(t, exec.sql, "INSERT INTO video_upload_sessions")
	assertSQLContains(t, exec.sql, "user_id")
	assertSQLContains(t, exec.sql, "storage_provider")
	assertSQLContains(t, exec.sql, "object_key")
	assertSQLContains(t, exec.sql, "upload_id")
	assertSQLContains(t, exec.sql, "metadata")
	if exec.args[0] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("expected creator id as user_id arg, got %#v", exec.args[0])
	}
	if exec.args[4] != "upl_test" {
		t.Fatalf("expected upload_id arg, got %#v", exec.args[4])
	}

	metadata := decodeJSONArg(t, exec.args[9])
	if metadata["filename"] != "clip.mp4" {
		t.Fatalf("expected filename metadata, got %#v", metadata["filename"])
	}
	if metadata["checksum_sha"] != "sha256:test" {
		t.Fatalf("expected checksum metadata, got %#v", metadata["checksum_sha"])
	}
}

func TestPostgresStoreCreateProcessingJobPersistsQueuePayload(t *testing.T) {
	db := &recordingPostgresDB{}
	store := newPostgresStore(db)
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	err := store.CreateProcessingJob(context.Background(), ProcessingJob{
		ID:          "33333333-3333-4333-8333-333333333333",
		VideoID:     "11111111-1111-4111-8111-111111111111",
		AssetID:     "22222222-2222-4222-8222-222222222222",
		JobType:     ProcessingJobTranscode,
		Status:      ProcessingJobQueued,
		Priority:    100,
		MaxAttempts: 3,
		ScheduledAt: now,
		CreatedAt:   now,
		Payload: map[string]any{
			"video_id":         "11111111-1111-4111-8111-111111111111",
			"asset_id":         "22222222-2222-4222-8222-222222222222",
			"upload_id":        "upl_test",
			"creator_id":       "44444444-4444-4444-8444-444444444444",
			"storage_provider": "r2",
			"bucket":           "swypik-video-uploads",
			"object_key":       "uploads/creator/upl_test/clip.mp4",
		},
	})
	if err != nil {
		t.Fatalf("expected create processing job, got %v", err)
	}

	exec := db.onlyExec(t)
	assertSQLContains(t, exec.sql, "INSERT INTO video_processing_jobs")
	assertSQLContains(t, exec.sql, "job_type")
	assertSQLContains(t, exec.sql, "status")
	assertSQLContains(t, exec.sql, "payload")
	if exec.args[3] != string(ProcessingJobTranscode) {
		t.Fatalf("expected transcode job type arg, got %#v", exec.args[3])
	}
	if exec.args[4] != string(ProcessingJobQueued) {
		t.Fatalf("expected queued status arg, got %#v", exec.args[4])
	}

	payload := decodeJSONArg(t, exec.args[9])
	if payload["upload_id"] != "upl_test" {
		t.Fatalf("expected upload_id payload, got %#v", payload["upload_id"])
	}
	if payload["object_key"] != "uploads/creator/upl_test/clip.mp4" {
		t.Fatalf("expected object_key payload, got %#v", payload["object_key"])
	}
}

type recordedExec struct {
	sql  string
	args []any
}

type recordingPostgresDB struct {
	execs []recordedExec
}

func (db *recordingPostgresDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execs = append(db.execs, recordedExec{sql: sql, args: append([]any(nil), args...)})
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (db *recordingPostgresDB) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("QueryRow is not used in these tests")
}

func (db *recordingPostgresDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query is not used in these tests")
}

func (db *recordingPostgresDB) onlyExec(t *testing.T) recordedExec {
	t.Helper()
	if len(db.execs) != 1 {
		t.Fatalf("expected one exec, got %d", len(db.execs))
	}
	return db.execs[0]
}

func assertSQLContains(t *testing.T, sql, want string) {
	t.Helper()
	if !strings.Contains(sql, want) {
		t.Fatalf("expected SQL to contain %q:\n%s", want, sql)
	}
}

func decodeJSONArg(t *testing.T, arg any) map[string]any {
	t.Helper()
	raw, ok := arg.([]byte)
	if !ok {
		t.Fatalf("expected []byte JSON arg, got %T", arg)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("expected JSON payload, got %v", err)
	}
	return out
}
