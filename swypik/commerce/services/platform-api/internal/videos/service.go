package videos

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	ErrValidation = errors.New("validation failed")
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
)

type UploadStatus string

const (
	UploadPending   UploadStatus = "uploading"
	UploadUploading UploadStatus = "uploading"
	UploadCompleted UploadStatus = "completed"
)

type VideoStatus string

const (
	VideoUploading   VideoStatus = "uploading"
	VideoProcessing  VideoStatus = "processing"
	VideoReady       VideoStatus = "ready"
	VideoPublished   VideoStatus = "ready"
	videoPublishedV1 VideoStatus = "published"
)

type VideoVisibility string

const (
	VideoVisibilityDraft    VideoVisibility = "draft"
	VideoVisibilityUnlisted VideoVisibility = "unlisted"
	VideoVisibilityPublic   VideoVisibility = "public"
	VideoVisibilityPrivate  VideoVisibility = "private"
)

type VideoAssetType string

const (
	VideoAssetSource VideoAssetType = "source"
)

type VideoAssetStatus string

const (
	VideoAssetAvailable VideoAssetStatus = "available"
)

type ProcessingJobType string

const (
	ProcessingJobTranscode ProcessingJobType = "transcode"
)

type ProcessingJobStatus string

const (
	ProcessingJobQueued ProcessingJobStatus = "queued"
)

type UploadConfig struct {
	PublicUploadBaseURL string
	UploadTTL           time.Duration
	StorageProvider     string
	Bucket              string
	Clock               func() time.Time
	Redis               interface {
		Enabled() bool
		Publish(context.Context, string, []byte) error
	}
	RedisStream string
}

type InitUploadInput struct {
	CreatorID    string `json:"creator_id"`
	UserID       string `json:"user_id,omitempty"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type"`
	SizeBytes    int64  `json:"size_bytes"`
	ProductID    string `json:"product_id,omitempty"`
	ChecksumSHA  string `json:"checksum_sha,omitempty"`
	OriginalName string `json:"original_name,omitempty"`
}

type InitUploadResult struct {
	UploadID  string            `json:"upload_id"`
	UploadURL string            `json:"upload_url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
	Status    UploadStatus      `json:"status"`
}

type CompleteUploadInput struct {
	UploadID    string `json:"upload_id"`
	CreatorID   string `json:"creator_id"`
	UserID      string `json:"user_id,omitempty"`
	VideoURL    string `json:"video_url"`
	PosterURL   string `json:"poster_url,omitempty"`
	DurationMS  int64  `json:"duration_ms,omitempty"`
	StoragePath string `json:"storage_path,omitempty"`
}

type PublishInput struct {
	CreatorID string `json:"creator_id"`
	UserID    string `json:"user_id,omitempty"`
}

type Upload struct {
	ID              string       `json:"id"`
	CreatorID       string       `json:"creator_id"`
	ProductID       string       `json:"product_id,omitempty"`
	Filename        string       `json:"filename"`
	ContentType     string       `json:"content_type"`
	SizeBytes       int64        `json:"size_bytes"`
	ChecksumSHA     string       `json:"checksum_sha,omitempty"`
	OriginalName    string       `json:"original_name,omitempty"`
	StorageProvider string       `json:"storage_provider,omitempty"`
	Bucket          string       `json:"bucket,omitempty"`
	ObjectKey       string       `json:"object_key,omitempty"`
	Status          UploadStatus `json:"status"`
	VideoID         string       `json:"video_id,omitempty"`
	UploadURL       string       `json:"upload_url,omitempty"`
	ExpiresAt       time.Time    `json:"expires_at"`
	CreatedAt       time.Time    `json:"created_at"`
	CompletedAt     time.Time    `json:"completed_at,omitempty"`
}

type Video struct {
	VideoID     string          `json:"video_id"`
	ID          string          `json:"id"`
	UploadID    string          `json:"upload_id,omitempty"`
	CreatorID   string          `json:"creator_id"`
	ProductID   string          `json:"product_id,omitempty"`
	Title       string          `json:"title,omitempty"`
	VideoURL    string          `json:"video_url"`
	PosterURL   string          `json:"poster_url,omitempty"`
	DurationMS  int64           `json:"duration_ms,omitempty"`
	Status      VideoStatus     `json:"status"`
	Visibility  VideoVisibility `json:"visibility,omitempty"`
	PublishedAt time.Time       `json:"published_at,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
}

type VideoAsset struct {
	ID              string           `json:"id"`
	VideoID         string           `json:"video_id"`
	AssetType       VideoAssetType   `json:"asset_type"`
	StorageProvider string           `json:"storage_provider"`
	Bucket          string           `json:"bucket"`
	ObjectKey       string           `json:"object_key"`
	PublicURL       string           `json:"public_url,omitempty"`
	MIMEType        string           `json:"mime_type,omitempty"`
	ByteSize        int64            `json:"byte_size,omitempty"`
	ChecksumSHA256  string           `json:"checksum_sha256,omitempty"`
	DurationMS      int64            `json:"duration_ms,omitempty"`
	Status          VideoAssetStatus `json:"status"`
	CreatedAt       time.Time        `json:"created_at"`
}

type ProcessingJob struct {
	ID           string              `json:"id"`
	VideoID      string              `json:"video_id"`
	AssetID      string              `json:"asset_id,omitempty"`
	JobType      ProcessingJobType   `json:"job_type"`
	Status       ProcessingJobStatus `json:"status"`
	Priority     int                 `json:"priority"`
	AttemptCount int                 `json:"attempt_count"`
	MaxAttempts  int                 `json:"max_attempts"`
	ScheduledAt  time.Time           `json:"scheduled_at"`
	Payload      map[string]any      `json:"payload"`
	CreatedAt    time.Time           `json:"created_at"`
}

type Comment struct {
	ID        string    `json:"id"`
	VideoID   string    `json:"video_id"`
	AuthorID  string    `json:"author_id"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

type AddCommentInput struct {
	AuthorID string `json:"author_id"`
	Body     string `json:"body"`
}

type UploadStore interface {
	CreateUpload(context.Context, Upload) error
	GetUpload(context.Context, string) (Upload, error)
	UpdateUpload(context.Context, Upload) error
	CreateVideo(context.Context, Video) error
	GetVideo(context.Context, string) (Video, error)
	UpdateVideo(context.Context, Video) error
	CreateVideoAsset(context.Context, VideoAsset) error
	CreateProcessingJob(context.Context, ProcessingJob) error
	ListComments(context.Context, string, int, int) ([]Comment, error)
	AddComment(context.Context, Comment) error
}

type UploadService struct {
	store UploadStore
	cfg   UploadConfig
}

func NewUploadService(store UploadStore, cfg UploadConfig) *UploadService {
	if store == nil {
		store = NewMemoryUploadStore()
	}
	if cfg.PublicUploadBaseURL == "" {
		cfg.PublicUploadBaseURL = "https://uploads.swypik.local"
	}
	cfg.PublicUploadBaseURL = strings.TrimRight(cfg.PublicUploadBaseURL, "/")
	if cfg.UploadTTL <= 0 {
		cfg.UploadTTL = 15 * time.Minute
	}
	if cfg.StorageProvider == "" {
		cfg.StorageProvider = "r2"
	}
	if cfg.Bucket == "" {
		cfg.Bucket = "swypik-video-uploads"
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.RedisStream == "" {
		cfg.RedisStream = "video:jobs"
	}
	return &UploadService{store: store, cfg: cfg}
}

func (s *UploadService) Init(ctx context.Context, input InitUploadInput) (InitUploadResult, error) {
	if err := validateInit(input); err != nil {
		return InitUploadResult{}, err
	}
	creatorID, _ := creatorIDFromAliases(input.CreatorID, input.UserID)
	now := s.cfg.Clock().UTC()
	uploadID := newUUID()
	objectKey := uploadObjectKey(creatorID, uploadID, input.Filename)
	uploadURL := fmt.Sprintf("%s/%s", s.cfg.PublicUploadBaseURL, objectKey)
	if presignedURL, ok := s.presignedUploadURL(objectKey, strings.TrimSpace(input.ContentType), now); ok {
		uploadURL = presignedURL
	}
	upload := Upload{
		ID:              uploadID,
		CreatorID:       creatorID,
		ProductID:       strings.TrimSpace(input.ProductID),
		Filename:        strings.TrimSpace(input.Filename),
		ContentType:     strings.TrimSpace(input.ContentType),
		SizeBytes:       input.SizeBytes,
		ChecksumSHA:     strings.TrimSpace(input.ChecksumSHA),
		OriginalName:    strings.TrimSpace(input.OriginalName),
		StorageProvider: s.cfg.StorageProvider,
		Bucket:          s.cfg.Bucket,
		ObjectKey:       objectKey,
		Status:          UploadPending,
		UploadURL:       uploadURL,
		ExpiresAt:       now.Add(s.cfg.UploadTTL),
		CreatedAt:       now,
	}
	if err := s.store.CreateUpload(ctx, upload); err != nil {
		return InitUploadResult{}, err
	}
	return InitUploadResult{
		UploadID:  upload.ID,
		UploadURL: upload.UploadURL,
		Method:    "PUT",
		Headers:   map[string]string{"Content-Type": upload.ContentType},
		ExpiresAt: upload.ExpiresAt,
		Status:    upload.Status,
	}, nil
}

func (s *UploadService) Status(ctx context.Context, uploadID string) (Upload, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return Upload{}, validationError("upload id is required")
	}
	return s.store.GetUpload(ctx, uploadID)
}

func (s *UploadService) Complete(ctx context.Context, input CompleteUploadInput) (Video, error) {
	if err := validateComplete(input); err != nil {
		return Video{}, err
	}
	creatorID, _ := creatorIDFromAliases(input.CreatorID, input.UserID)
	upload, err := s.store.GetUpload(ctx, strings.TrimSpace(input.UploadID))
	if err != nil {
		return Video{}, err
	}
	if upload.CreatorID != "" && upload.CreatorID != creatorID {
		return Video{}, validationError("creator_id does not match upload")
	}
	if upload.Status == UploadCompleted && upload.VideoID != "" {
		return s.store.GetVideo(ctx, upload.VideoID)
	}
	now := s.cfg.Clock().UTC()
	objectKey := strings.TrimSpace(input.StoragePath)
	if objectKey == "" {
		objectKey = upload.ObjectKey
	}
	videoURL := strings.TrimSpace(input.VideoURL)
	if videoURL == "" {
		videoURL = s.publicURLForObject(objectKey)
	}
	video := Video{
		VideoID:    newUUID(),
		UploadID:   upload.ID,
		CreatorID:  upload.CreatorID,
		ProductID:  upload.ProductID,
		Title:      uploadTitle(upload),
		VideoURL:   videoURL,
		PosterURL:  strings.TrimSpace(input.PosterURL),
		DurationMS: input.DurationMS,
		Status:     VideoProcessing,
		Visibility: VideoVisibilityDraft,
		CreatedAt:  now,
	}
	video.ID = video.VideoID
	asset := VideoAsset{
		ID:              newUUID(),
		VideoID:         video.ID,
		AssetType:       VideoAssetSource,
		StorageProvider: upload.StorageProvider,
		Bucket:          upload.Bucket,
		ObjectKey:       objectKey,
		PublicURL:       videoURL,
		MIMEType:        upload.ContentType,
		ByteSize:        upload.SizeBytes,
		ChecksumSHA256:  upload.ChecksumSHA,
		DurationMS:      input.DurationMS,
		Status:          VideoAssetAvailable,
		CreatedAt:       now,
	}
	job := ProcessingJob{
		ID:           newUUID(),
		VideoID:      video.ID,
		AssetID:      asset.ID,
		JobType:      ProcessingJobTranscode,
		Status:       ProcessingJobQueued,
		Priority:     100,
		AttemptCount: 0,
		MaxAttempts:  3,
		ScheduledAt:  now,
		Payload:      processingPayload(upload, video, asset),
		CreatedAt:    now,
	}
	job.Payload["job_id"] = job.ID
	upload.Status = UploadCompleted
	upload.VideoID = video.ID
	upload.CompletedAt = now
	if err := s.store.CreateVideo(ctx, video); err != nil {
		return Video{}, err
	}
	if err := s.store.CreateVideoAsset(ctx, asset); err != nil {
		return Video{}, err
	}
	if err := s.store.CreateProcessingJob(ctx, job); err != nil {
		return Video{}, err
	}
	if err := s.store.UpdateUpload(ctx, upload); err != nil {
		return Video{}, err
	}
	if s.cfg.Redis != nil && s.cfg.Redis.Enabled() {
		if payload, err := jsonBytes(job.Payload); err == nil {
			_ = s.cfg.Redis.Publish(ctx, s.cfg.RedisStream, payload)
		}
	}
	return video, nil
}

func (s *UploadService) Publish(ctx context.Context, videoID string, input PublishInput) (Video, error) {
	videoID = strings.TrimSpace(videoID)
	if videoID == "" {
		return Video{}, validationError("video id is required")
	}
	video, err := s.store.GetVideo(ctx, videoID)
	if err != nil {
		return Video{}, err
	}
	creatorID, err := creatorIDFromAliases(input.CreatorID, input.UserID)
	if err != nil {
		return Video{}, err
	}
	if video.CreatorID != "" && creatorID != "" && video.CreatorID != creatorID {
		return Video{}, validationError("creator_id does not match video")
	}
	if video.Status != VideoReady && video.Status != videoPublishedV1 {
		return Video{}, fmt.Errorf("%w: video is not ready", ErrConflict)
	}
	if video.Status != VideoReady || video.Visibility != VideoVisibilityPublic {
		video.Status = VideoReady
		video.Visibility = VideoVisibilityPublic
		if video.PublishedAt.IsZero() {
			video.PublishedAt = s.cfg.Clock().UTC()
		}
		if err := s.store.UpdateVideo(ctx, video); err != nil {
			return Video{}, err
		}
	} else if video.PublishedAt.IsZero() {
		video.PublishedAt = s.cfg.Clock().UTC()
		if err := s.store.UpdateVideo(ctx, video); err != nil {
			return Video{}, err
		}
	}
	return video, nil
}

func (s *UploadService) ListComments(ctx context.Context, videoID string, limit, offset int) ([]Comment, error) {
	videoID = strings.TrimSpace(videoID)
	if videoID == "" {
		return nil, validationError("video id is required")
	}
	limit = boundedInt(limit, 25, 1, 100)
	if offset < 0 {
		offset = 0
	}
	return s.store.ListComments(ctx, videoID, limit, offset)
}

func (s *UploadService) AddComment(ctx context.Context, videoID string, input AddCommentInput) (Comment, error) {
	videoID = strings.TrimSpace(videoID)
	if videoID == "" {
		return Comment{}, validationError("video id is required")
	}
	if strings.TrimSpace(input.AuthorID) == "" {
		return Comment{}, validationError("author_id is required")
	}
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return Comment{}, validationError("body is required")
	}
	if len(body) > 2_000 {
		return Comment{}, validationError("body cannot exceed 2000 characters")
	}
	comment := Comment{
		ID:        newID("cmt"),
		VideoID:   videoID,
		AuthorID:  strings.TrimSpace(input.AuthorID),
		Body:      body,
		CreatedAt: s.cfg.Clock().UTC(),
	}
	if err := s.store.AddComment(ctx, comment); err != nil {
		return Comment{}, err
	}
	return comment, nil
}

func validateInit(input InitUploadInput) error {
	creatorID, err := creatorIDFromAliases(input.CreatorID, input.UserID)
	if err != nil {
		return err
	}
	if creatorID == "" {
		return validationError("creator_id is required")
	}
	if strings.TrimSpace(input.Filename) == "" {
		return validationError("filename is required")
	}
	if input.SizeBytes <= 0 {
		return validationError("size_bytes must be positive")
	}
	if input.SizeBytes > 1024*1024*1024 {
		return validationError("size_bytes exceeds 1GB")
	}
	contentType := strings.ToLower(strings.TrimSpace(input.ContentType))
	if !strings.HasPrefix(contentType, "video/") {
		return validationError("content_type must be a video type")
	}
	return nil
}

func validateComplete(input CompleteUploadInput) error {
	if strings.TrimSpace(input.UploadID) == "" {
		return validationError("upload_id is required")
	}
	creatorID, err := creatorIDFromAliases(input.CreatorID, input.UserID)
	if err != nil {
		return err
	}
	if creatorID == "" {
		return validationError("creator_id is required")
	}
	if input.DurationMS < 0 {
		return validationError("duration_ms cannot be negative")
	}
	return nil
}

func validationError(message string) error {
	return fmt.Errorf("%w: %s", ErrValidation, message)
}

func creatorIDFromAliases(creatorID, userID string) (string, error) {
	creatorID = strings.TrimSpace(creatorID)
	userID = strings.TrimSpace(userID)
	if creatorID != "" && userID != "" && creatorID != userID {
		return "", validationError("creator_id and user_id do not match")
	}
	if creatorID != "" {
		return creatorID, nil
	}
	return userID, nil
}

func sanitizeFilename(filename string) string {
	filename = strings.TrimSpace(filename)
	filename = strings.ReplaceAll(filename, "\\", "_")
	filename = strings.ReplaceAll(filename, "/", "_")
	if filename == "" {
		return "upload.bin"
	}
	return filename
}

func uploadObjectKey(creatorID, uploadID, filename string) string {
	return strings.Join([]string{
		"uploads",
		sanitizePathPart(creatorID),
		sanitizePathPart(uploadID),
		sanitizeFilename(filename),
	}, "/")
}

func sanitizePathPart(part string) string {
	part = sanitizeFilename(part)
	part = strings.ReplaceAll(part, " ", "_")
	return part
}

func uploadTitle(upload Upload) string {
	if upload.OriginalName != "" {
		return upload.OriginalName
	}
	return upload.Filename
}

func processingPayload(upload Upload, video Video, asset VideoAsset) map[string]any {
	hlsPrefix := fmt.Sprintf("videos/hls/%s", video.ID)
	return map[string]any{
		"job_type":        "process_video",
		"type":            "process_video",
		"video_id":         video.ID,
		"asset_id":         asset.ID,
		"upload_id":        upload.ID,
		"creator_id":       video.CreatorID,
		"product_id":       video.ProductID,
		"storage_provider": asset.StorageProvider,
		"bucket":           asset.Bucket,
		"source_bucket":    asset.Bucket,
		"output_bucket":    asset.Bucket,
		"object_key":       asset.ObjectKey,
		"source_key":       asset.ObjectKey,
		"output_prefix":    hlsPrefix,
		"thumbnail_key":    fmt.Sprintf("videos/thumbnails/%s.jpg", video.ID),
		"preview_key":      fmt.Sprintf("videos/previews/%s.mp4", video.ID),
		"hls_master_key":   fmt.Sprintf("%s/master.m3u8", hlsPrefix),
		"source_url":       asset.PublicURL,
		"content_type":     asset.MIMEType,
		"byte_size":        asset.ByteSize,
		"checksum_sha256":  asset.ChecksumSHA256,
		"duration_ms":      asset.DurationMS,
	}
}

func jsonBytes(value any) ([]byte, error) {
	return json.Marshal(value)
}

func (s *UploadService) publicURLForObject(objectKey string) string {
	return strings.TrimRight(s.cfg.PublicUploadBaseURL, "/") + "/" + strings.TrimLeft(objectKey, "/")
}

func (s *UploadService) presignedUploadURL(objectKey, contentType string, now time.Time) (string, bool) {
	endpoint := strings.TrimRight(firstNonEmptyEnv("S3_ENDPOINT", "S3_ENDPOINT_URL", "R2_ENDPOINT", "R2_ENDPOINT_URL"), "/")
	accessKey := firstNonEmptyEnv("S3_ACCESS_KEY_ID", "S3_ACCESS_KEY", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
	secretKey := firstNonEmptyEnv("S3_SECRET_ACCESS_KEY", "S3_SECRET_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
	region := firstNonEmptyEnv("S3_REGION", "R2_REGION", "AWS_REGION")
	bucket := firstNonEmptyEnv("S3_MEDIA_BUCKET", "S3_BUCKET", "R2_BUCKET")
	if bucket == "" {
		bucket = strings.TrimSpace(s.cfg.Bucket)
	}
	if endpoint == "" || accessKey == "" || secretKey == "" || region == "" || bucket == "" {
		return "", false
	}
	endpointURL, err := url.Parse(endpoint)
	if err != nil || endpointURL.Scheme == "" || endpointURL.Host == "" {
		return "", false
	}
	expires := int64(s.cfg.UploadTTL.Seconds())
	if expires <= 0 {
		expires = 900
	}
	date := now.UTC().Format("20060102")
	amzDate := now.UTC().Format("20060102T150405Z")
	credentialScope := date + "/" + region + "/s3/aws4_request"
	credential := accessKey + "/" + credentialScope
	canonicalURI := "/" + bucket + "/" + objectKey
	escapedPath := strings.ReplaceAll(canonicalURI, " ", "%20")
	query := url.Values{}
	query.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	query.Set("X-Amz-Credential", credential)
	query.Set("X-Amz-Date", amzDate)
	query.Set("X-Amz-Expires", fmt.Sprintf("%d", expires))
	query.Set("X-Amz-SignedHeaders", "content-type;host")
	canonicalQuery := query.Encode()
	payloadHash := "UNSIGNED-PAYLOAD"
	canonicalHeaders := "content-type:" + strings.TrimSpace(contentType) + "\n" + "host:" + endpointURL.Host + "\n"
	canonicalRequest := strings.Join([]string{
		"PUT",
		escapedPath,
		canonicalQuery,
		canonicalHeaders,
		"content-type;host",
		payloadHash,
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hexSHA256(canonicalRequest),
	}, "\n")
	signingKey := s3SigningKey(secretKey, date, region)
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))
	query.Set("X-Amz-Signature", signature)
	endpointURL.Path = canonicalURI
	endpointURL.RawQuery = query.Encode()
	return endpointURL.String(), true
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func hexSHA256(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(value))
	return mac.Sum(nil)
}

func s3SigningKey(secret, date, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), date)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, "s3")
	return hmacSHA256(kService, "aws4_request")
}

func boundedInt(value, fallback, low, high int) int {
	if value == 0 {
		return fallback
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

type MemoryUploadStore struct {
	mu       sync.RWMutex
	uploads  map[string]Upload
	videos   map[string]Video
	assets   map[string]VideoAsset
	jobs     []ProcessingJob
	comments map[string][]Comment
}

func NewMemoryUploadStore() *MemoryUploadStore {
	return &MemoryUploadStore{
		uploads:  make(map[string]Upload),
		videos:   make(map[string]Video),
		assets:   make(map[string]VideoAsset),
		comments: make(map[string][]Comment),
	}
}

func (s *MemoryUploadStore) CreateUpload(_ context.Context, upload Upload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads[upload.ID] = upload
	return nil
}

func (s *MemoryUploadStore) GetUpload(_ context.Context, id string) (Upload, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	upload, ok := s.uploads[id]
	if !ok {
		return Upload{}, fmt.Errorf("%w: upload %s", ErrNotFound, id)
	}
	return upload, nil
}

func (s *MemoryUploadStore) UpdateUpload(_ context.Context, upload Upload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.uploads[upload.ID]; !ok {
		return fmt.Errorf("%w: upload %s", ErrNotFound, upload.ID)
	}
	s.uploads[upload.ID] = upload
	return nil
}

func (s *MemoryUploadStore) CreateVideo(_ context.Context, video Video) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if video.VideoID == "" {
		video.VideoID = video.ID
	}
	if video.ID == "" {
		video.ID = video.VideoID
	}
	if video.Visibility == "" {
		video.Visibility = VideoVisibilityDraft
	}
	s.videos[video.ID] = video
	return nil
}

func (s *MemoryUploadStore) GetVideo(_ context.Context, id string) (Video, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	video, ok := s.videos[id]
	if !ok {
		return Video{}, fmt.Errorf("%w: video %s", ErrNotFound, id)
	}
	return video, nil
}

func (s *MemoryUploadStore) UpdateVideo(_ context.Context, video Video) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.videos[video.ID]; !ok {
		return fmt.Errorf("%w: video %s", ErrNotFound, video.ID)
	}
	s.videos[video.ID] = video
	return nil
}

func (s *MemoryUploadStore) CreateVideoAsset(_ context.Context, asset VideoAsset) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.assets[asset.ID] = asset
	return nil
}

func (s *MemoryUploadStore) CreateProcessingJob(_ context.Context, job ProcessingJob) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job.Payload = clonePayload(job.Payload)
	s.jobs = append(s.jobs, job)
	return nil
}

func (s *MemoryUploadStore) ProcessingJobs() []ProcessingJob {
	s.mu.RLock()
	defer s.mu.RUnlock()
	jobs := make([]ProcessingJob, len(s.jobs))
	for i, job := range s.jobs {
		job.Payload = clonePayload(job.Payload)
		jobs[i] = job
	}
	return jobs
}

func (s *MemoryUploadStore) ListComments(_ context.Context, videoID string, limit, offset int) ([]Comment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	comments := append([]Comment(nil), s.comments[videoID]...)
	start := min(offset, len(comments))
	end := min(start+limit, len(comments))
	return comments[start:end], nil
}

func (s *MemoryUploadStore) AddComment(_ context.Context, comment Comment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.comments[comment.VideoID] = append(s.comments[comment.VideoID], comment)
	return nil
}

func clonePayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	clone := make(map[string]any, len(payload))
	for key, value := range payload {
		clone[key] = value
	}
	return clone
}
