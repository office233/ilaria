package videos

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestUploadLifecycleInitializesCompletesAndPublishesVideo(t *testing.T) {
	ctx := context.Background()
	clock := fixedClock(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           15 * time.Minute,
		Clock:               clock,
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:    "creator_1",
		Filename:     "clip.mp4",
		ContentType:  "video/mp4",
		SizeBytes:    1024 * 1024,
		ProductID:    "product_1",
		ChecksumSHA:  "sha256:test",
		OriginalName: "launch clip",
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}
	if initResult.UploadID == "" {
		t.Fatal("expected upload id")
	}
	if initResult.Method != "PUT" {
		t.Fatalf("expected PUT upload method, got %q", initResult.Method)
	}
	if initResult.ExpiresAt != clock().Add(15*time.Minute) {
		t.Fatalf("expected ttl-derived expiry, got %s", initResult.ExpiresAt)
	}

	status, err := service.Status(ctx, initResult.UploadID)
	if err != nil {
		t.Fatalf("expected pending status, got %v", err)
	}
	if status.Status != UploadPending {
		t.Fatalf("expected pending upload, got %s", status.Status)
	}

	completeResult, err := service.Complete(ctx, CompleteUploadInput{
		UploadID:   initResult.UploadID,
		CreatorID:  "creator_1",
		VideoURL:   "https://cdn.swypik.test/clip.mp4",
		PosterURL:  "https://cdn.swypik.test/clip.jpg",
		DurationMS: 15_000,
	})
	if err != nil {
		t.Fatalf("expected upload complete, got %v", err)
	}
	if completeResult.Status != VideoProcessing {
		t.Fatalf("expected processing video, got %s", completeResult.Status)
	}

	completeResult.Status = VideoReady
	if err := store.UpdateVideo(ctx, completeResult); err != nil {
		t.Fatalf("expected processor to mark video ready, got %v", err)
	}

	published, err := service.Publish(ctx, completeResult.VideoID, PublishInput{CreatorID: "creator_1"})
	if err != nil {
		t.Fatalf("expected publish, got %v", err)
	}
	if published.Status != VideoReady {
		t.Fatalf("expected ready video after publish, got %s", published.Status)
	}
	if published.Visibility != VideoVisibilityPublic {
		t.Fatalf("expected public video after publish, got %s", published.Visibility)
	}
}

func TestUploadInputsAcceptUserIDAliasForCreatorID(t *testing.T) {
	ctx := context.Background()
	service := NewUploadService(NewMemoryUploadStore(), UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           15 * time.Minute,
		Clock:               fixedClock(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)),
	})

	initInput := strictDecode[InitUploadInput](t, `{
		"user_id": "creator_alias",
		"filename": "clip.mp4",
		"content_type": "video/mp4",
		"size_bytes": 2048
	}`)
	initResult, err := service.Init(ctx, initInput)
	if err != nil {
		t.Fatalf("expected upload init with user_id alias, got %v", err)
	}
	status, err := service.Status(ctx, initResult.UploadID)
	if err != nil {
		t.Fatalf("expected upload status, got %v", err)
	}
	if status.CreatorID != "creator_alias" {
		t.Fatalf("expected user_id alias to populate creator id, got %q", status.CreatorID)
	}

	completeInput := strictDecode[CompleteUploadInput](t, `{
		"upload_id": "`+initResult.UploadID+`",
		"user_id": "creator_alias",
		"video_url": "https://cdn.swypik.test/clip.mp4",
		"duration_ms": 15000
	}`)
	video, err := service.Complete(ctx, completeInput)
	if err != nil {
		t.Fatalf("expected upload complete with user_id alias, got %v", err)
	}
	if video.CreatorID != "creator_alias" {
		t.Fatalf("expected completed video creator id from user_id alias, got %q", video.CreatorID)
	}
}

func TestCompleteUploadQueuesProcessingJobWithSourcePayload(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           15 * time.Minute,
		Clock:               fixedClock(now),
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:   "creator_1",
		Filename:    "launch.mp4",
		ContentType: "video/mp4",
		SizeBytes:   4096,
		ProductID:   "product_1",
		ChecksumSHA: "sha256:test",
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}

	video, err := service.Complete(ctx, CompleteUploadInput{
		UploadID:    initResult.UploadID,
		CreatorID:   "creator_1",
		VideoURL:    "https://cdn.swypik.test/launch.mp4",
		PosterURL:   "https://cdn.swypik.test/launch.jpg",
		DurationMS:  42_000,
		StoragePath: "uploads/creator_1/launch.mp4",
	})
	if err != nil {
		t.Fatalf("expected upload complete, got %v", err)
	}
	if video.Status != VideoProcessing {
		t.Fatalf("expected processing video, got %s", video.Status)
	}
	if video.Visibility != VideoVisibilityDraft {
		t.Fatalf("expected draft video visibility, got %s", video.Visibility)
	}

	jobs := store.ProcessingJobs()
	if len(jobs) != 1 {
		t.Fatalf("expected one processing job, got %d", len(jobs))
	}
	job := jobs[0]
	if job.VideoID != video.ID {
		t.Fatalf("expected job video id %q, got %q", video.ID, job.VideoID)
	}
	if job.JobType != ProcessingJobTranscode {
		t.Fatalf("expected transcode job, got %s", job.JobType)
	}
	if job.Status != ProcessingJobQueued {
		t.Fatalf("expected queued job, got %s", job.Status)
	}
	if job.AssetID == "" {
		t.Fatal("expected processing job to reference source asset")
	}
	assertPayloadString(t, job.Payload, "video_id", video.ID)
	assertPayloadString(t, job.Payload, "asset_id", job.AssetID)
	assertPayloadString(t, job.Payload, "upload_id", initResult.UploadID)
	assertPayloadString(t, job.Payload, "creator_id", "creator_1")
	assertPayloadString(t, job.Payload, "storage_provider", "r2")
	assertPayloadString(t, job.Payload, "bucket", "swypik-video-uploads")
	assertPayloadString(t, job.Payload, "job_type", "process_video")
	assertPayloadString(t, job.Payload, "object_key", "uploads/creator_1/launch.mp4")
	assertPayloadString(t, job.Payload, "source_key", "uploads/creator_1/launch.mp4")
	assertPayloadString(t, job.Payload, "output_prefix", "videos/hls/"+video.ID)
	assertPayloadString(t, job.Payload, "thumbnail_key", "videos/thumbnails/"+video.ID+".jpg")
	assertPayloadString(t, job.Payload, "preview_key", "videos/previews/"+video.ID+".mp4")
	assertPayloadString(t, job.Payload, "hls_master_key", "videos/hls/"+video.ID+"/master.m3u8")
	assertPayloadString(t, job.Payload, "source_url", "https://cdn.swypik.test/launch.mp4")
	assertPayloadString(t, job.Payload, "content_type", "video/mp4")
	assertPayloadString(t, job.Payload, "checksum_sha256", "sha256:test")
	assertPayloadInt64(t, job.Payload, "byte_size", 4096)
}

func TestUploadInitUsesS3CompatiblePresignedPUTURLWhenConfigured(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "http://minio.swypik.test:9000")
	t.Setenv("S3_REGION", "us-east-1")
	t.Setenv("S3_ACCESS_KEY_ID", "test-access")
	t.Setenv("S3_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("S3_MEDIA_BUCKET", "swypik-media")
	t.Setenv("S3_FORCE_PATH_STYLE", "true")

	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	service := NewUploadService(NewMemoryUploadStore(), UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           10 * time.Minute,
		Clock:               fixedClock(now),
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:   "creator 1",
		Filename:    "folder/clip final.mp4",
		ContentType: "video/mp4",
		SizeBytes:   4096,
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}

	uploadURL, err := url.Parse(initResult.UploadURL)
	if err != nil {
		t.Fatalf("expected parseable upload url, got %v", err)
	}
	if uploadURL.Scheme != "http" || uploadURL.Host != "minio.swypik.test:9000" {
		t.Fatalf("expected MinIO endpoint URL, got %s", initResult.UploadURL)
	}
	wantPath := "/swypik-media/uploads/creator_1/" + initResult.UploadID + "/folder_clip final.mp4"
	if uploadURL.Path != wantPath {
		t.Fatalf("expected path %q, got %q", wantPath, uploadURL.Path)
	}

	query := uploadURL.Query()
	if query.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		t.Fatalf("expected SigV4 algorithm, got %q", query.Get("X-Amz-Algorithm"))
	}
	if !strings.HasPrefix(query.Get("X-Amz-Credential"), "test-access/20260510/us-east-1/s3/aws4_request") {
		t.Fatalf("expected credential scope in query, got %q", query.Get("X-Amz-Credential"))
	}
	if query.Get("X-Amz-Date") != "20260510T120000Z" {
		t.Fatalf("expected signing date, got %q", query.Get("X-Amz-Date"))
	}
	if query.Get("X-Amz-Expires") != "600" {
		t.Fatalf("expected TTL seconds, got %q", query.Get("X-Amz-Expires"))
	}
	if query.Get("X-Amz-SignedHeaders") != "content-type;host" {
		t.Fatalf("expected signed content-type and host headers, got %q", query.Get("X-Amz-SignedHeaders"))
	}
	if len(query.Get("X-Amz-Signature")) != 64 {
		t.Fatalf("expected hex signature, got %q", query.Get("X-Amz-Signature"))
	}
	if initResult.Headers["Content-Type"] != "video/mp4" {
		t.Fatalf("expected upload content-type header, got %#v", initResult.Headers)
	}
}

func TestUploadInitAcceptsProductionR2EnvAliases(t *testing.T) {
	t.Setenv("S3_ENDPOINT_URL", "https://r2.swypik.test")
	t.Setenv("S3_REGION", "auto")
	t.Setenv("S3_ACCESS_KEY", "alias-access")
	t.Setenv("S3_SECRET_KEY", "alias-secret")
	t.Setenv("S3_BUCKET", "swypik-media-prod")

	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	service := NewUploadService(NewMemoryUploadStore(), UploadConfig{
		PublicUploadBaseURL: "https://media.swypik.test",
		UploadTTL:           10 * time.Minute,
		Clock:               fixedClock(now),
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:   "creator_1",
		Filename:    "clip.mp4",
		ContentType: "video/mp4",
		SizeBytes:   4096,
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}

	uploadURL, err := url.Parse(initResult.UploadURL)
	if err != nil {
		t.Fatalf("expected parseable upload url, got %v", err)
	}
	if uploadURL.Host != "r2.swypik.test" {
		t.Fatalf("expected R2 alias endpoint, got %s", initResult.UploadURL)
	}
	if !strings.HasPrefix(uploadURL.Query().Get("X-Amz-Credential"), "alias-access/20260510/auto/s3/aws4_request") {
		t.Fatalf("expected aliased access key in credential, got %q", uploadURL.Query().Get("X-Amz-Credential"))
	}
}

func TestCompleteCreatesVideoBeforeLinkingUploadToVideo(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := newSequencingUploadStore()
	service := NewUploadService(store, UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           15 * time.Minute,
		Clock:               fixedClock(now),
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:   "creator_1",
		Filename:    "launch.mp4",
		ContentType: "video/mp4",
		SizeBytes:   4096,
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}

	if _, err := service.Complete(ctx, CompleteUploadInput{
		UploadID:   initResult.UploadID,
		CreatorID:  "creator_1",
		DurationMS: 42_000,
	}); err != nil {
		t.Fatalf("expected upload complete, got %v", err)
	}

	assertCallOrder(t, store.calls, "CreateVideo", "UpdateUpload")
}

func TestCompleteUploadDerivesVideoURLFromObjectKeyWhenVideoURLIsOmitted(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test/media",
		UploadTTL:           15 * time.Minute,
		Clock:               fixedClock(now),
	})

	initResult, err := service.Init(ctx, InitUploadInput{
		CreatorID:   "creator_1",
		Filename:    "launch.mp4",
		ContentType: "video/mp4",
		SizeBytes:   4096,
	})
	if err != nil {
		t.Fatalf("expected upload init, got %v", err)
	}

	video, err := service.Complete(ctx, CompleteUploadInput{
		UploadID:   initResult.UploadID,
		CreatorID:  "creator_1",
		DurationMS: 42_000,
	})
	if err != nil {
		t.Fatalf("expected upload complete, got %v", err)
	}

	wantURL := "https://uploads.swypik.test/media/uploads/creator_1/" + initResult.UploadID + "/launch.mp4"
	if video.VideoURL != wantURL {
		t.Fatalf("expected derived video url %q, got %q", wantURL, video.VideoURL)
	}
	jobs := store.ProcessingJobs()
	if len(jobs) != 1 {
		t.Fatalf("expected one processing job, got %d", len(jobs))
	}
	assertPayloadString(t, jobs[0].Payload, "source_url", wantURL)
}

func TestPublishMarksReadyVideoPublicWithoutPublishedStatus(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{Clock: fixedClock(now)})
	video := Video{
		VideoID:    "video_ready",
		ID:         "video_ready",
		CreatorID:  "creator_1",
		VideoURL:   "https://cdn.swypik.test/ready.mp4",
		Status:     VideoReady,
		Visibility: VideoVisibilityDraft,
		CreatedAt:  now,
	}
	if err := store.CreateVideo(ctx, video); err != nil {
		t.Fatalf("expected seed video, got %v", err)
	}

	published, err := service.Publish(ctx, video.ID, PublishInput{CreatorID: "creator_1"})
	if err != nil {
		t.Fatalf("expected publish, got %v", err)
	}
	if published.Status != VideoReady {
		t.Fatalf("expected schema ready status, got %s", published.Status)
	}
	if published.Visibility != VideoVisibilityPublic {
		t.Fatalf("expected public visibility, got %s", published.Visibility)
	}
	if !published.PublishedAt.Equal(now) {
		t.Fatalf("expected published_at %s, got %s", now, published.PublishedAt)
	}
}

func TestPublishRejectsProcessingVideo(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{Clock: fixedClock(time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC))})
	video := Video{
		VideoID:    "video_processing",
		ID:         "video_processing",
		CreatorID:  "creator_1",
		VideoURL:   "https://cdn.swypik.test/processing.mp4",
		Status:     VideoProcessing,
		Visibility: VideoVisibilityDraft,
	}
	if err := store.CreateVideo(ctx, video); err != nil {
		t.Fatalf("expected seed video, got %v", err)
	}

	_, err := service.Publish(ctx, video.ID, PublishInput{CreatorID: "creator_1"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict for processing video, got %v", err)
	}
}

func TestPublishNormalizesLegacyPublishedStatus(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	store := NewMemoryUploadStore()
	service := NewUploadService(store, UploadConfig{Clock: fixedClock(now)})
	video := Video{
		VideoID:   "video_legacy",
		ID:        "video_legacy",
		CreatorID: "creator_1",
		VideoURL:  "https://cdn.swypik.test/legacy.mp4",
		Status:    VideoStatus("published"),
		CreatedAt: now,
	}
	if err := store.CreateVideo(ctx, video); err != nil {
		t.Fatalf("expected seed video, got %v", err)
	}

	published, err := service.Publish(ctx, video.ID, PublishInput{CreatorID: "creator_1"})
	if err != nil {
		t.Fatalf("expected legacy publish normalization, got %v", err)
	}
	if published.Status != VideoReady {
		t.Fatalf("expected legacy status normalized to ready, got %s", published.Status)
	}
	if published.Visibility != VideoVisibilityPublic {
		t.Fatalf("expected legacy status to imply public visibility, got %s", published.Visibility)
	}
}

func TestUploadInitRejectsNonVideoContent(t *testing.T) {
	service := NewUploadService(NewMemoryUploadStore(), UploadConfig{
		PublicUploadBaseURL: "https://uploads.swypik.test",
		UploadTTL:           15 * time.Minute,
		Clock:               time.Now,
	})

	_, err := service.Init(context.Background(), InitUploadInput{
		CreatorID:   "creator_1",
		Filename:    "still.png",
		ContentType: "image/png",
		SizeBytes:   1024,
	})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for non-video content, got %v", err)
	}
}

func fixedClock(now time.Time) func() time.Time {
	return func() time.Time { return now }
}

func strictDecode[T any](t *testing.T, payload string) T {
	t.Helper()
	var out T
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&out); err != nil {
		t.Fatalf("expected strict decode, got %v", err)
	}
	return out
}

func assertPayloadString(t *testing.T, payload map[string]any, key, want string) {
	t.Helper()
	if got, _ := payload[key].(string); got != want {
		t.Fatalf("expected payload[%s] %q, got %#v", key, want, payload[key])
	}
}

func assertPayloadInt64(t *testing.T, payload map[string]any, key string, want int64) {
	t.Helper()
	if got, _ := payload[key].(int64); got != want {
		t.Fatalf("expected payload[%s] %d, got %#v", key, want, payload[key])
	}
}

type sequencingUploadStore struct {
	*MemoryUploadStore
	calls []string
}

func newSequencingUploadStore() *sequencingUploadStore {
	return &sequencingUploadStore{MemoryUploadStore: NewMemoryUploadStore()}
}

func (s *sequencingUploadStore) CreateUpload(ctx context.Context, upload Upload) error {
	s.calls = append(s.calls, "CreateUpload")
	return s.MemoryUploadStore.CreateUpload(ctx, upload)
}

func (s *sequencingUploadStore) UpdateUpload(ctx context.Context, upload Upload) error {
	s.calls = append(s.calls, "UpdateUpload")
	return s.MemoryUploadStore.UpdateUpload(ctx, upload)
}

func (s *sequencingUploadStore) CreateVideo(ctx context.Context, video Video) error {
	s.calls = append(s.calls, "CreateVideo")
	return s.MemoryUploadStore.CreateVideo(ctx, video)
}

func (s *sequencingUploadStore) CreateVideoAsset(ctx context.Context, asset VideoAsset) error {
	s.calls = append(s.calls, "CreateVideoAsset")
	return s.MemoryUploadStore.CreateVideoAsset(ctx, asset)
}

func (s *sequencingUploadStore) CreateProcessingJob(ctx context.Context, job ProcessingJob) error {
	s.calls = append(s.calls, "CreateProcessingJob")
	return s.MemoryUploadStore.CreateProcessingJob(ctx, job)
}

func assertCallOrder(t *testing.T, calls []string, before, after string) {
	t.Helper()
	beforeIndex := -1
	afterIndex := -1
	for i, call := range calls {
		if call == before && beforeIndex == -1 {
			beforeIndex = i
		}
		if call == after && afterIndex == -1 {
			afterIndex = i
		}
	}
	if beforeIndex == -1 || afterIndex == -1 {
		t.Fatalf("expected calls to include %s and %s, got %#v", before, after, calls)
	}
	if beforeIndex > afterIndex {
		t.Fatalf("expected %s before %s, got %#v", before, after, calls)
	}
}
