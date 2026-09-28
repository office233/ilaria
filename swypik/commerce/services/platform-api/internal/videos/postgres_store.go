package videos

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type postgresExecDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type postgresStore struct {
	db postgresExecDB
}

func newPostgresStore(db postgresExecDB) *postgresStore {
	return &postgresStore{db: db}
}

func (s *postgresStore) CreateUpload(ctx context.Context, u Upload) error {
	metadata, err := json.Marshal(map[string]any{
		"filename":      u.Filename,
		"original_name": u.OriginalName,
		"product_id":    u.ProductID,
		"checksum_sha":  u.ChecksumSHA,
		"upload_url":    u.UploadURL,
	})
	if err != nil {
		return fmt.Errorf("videos.postgresStore.CreateUpload metadata: %w", err)
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO video_upload_sessions (
			user_id, storage_provider, bucket, object_key, upload_id, content_type,
			byte_size, status, expires_at, metadata, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
	`,
		u.CreatorID,
		u.StorageProvider,
		u.Bucket,
		u.ObjectKey,
		u.ID,
		u.ContentType,
		u.SizeBytes,
		string(u.Status),
		u.ExpiresAt,
		metadata,
		u.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("videos.postgresStore.CreateUpload: %w", err)
	}
	return nil
}

func (s *postgresStore) CreateProcessingJob(ctx context.Context, job ProcessingJob) error {
	payload, err := json.Marshal(job.Payload)
	if err != nil {
		return fmt.Errorf("videos.postgresStore.CreateProcessingJob payload: %w", err)
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO video_processing_jobs (
			id, video_id, asset_id, job_type, status, priority, attempt_count,
			max_attempts, scheduled_at, payload, created_at, updated_at
		) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)
	`,
		job.ID,
		job.VideoID,
		job.AssetID,
		string(job.JobType),
		string(job.Status),
		job.Priority,
		job.AttemptCount,
		job.MaxAttempts,
		job.ScheduledAt,
		payload,
		job.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("videos.postgresStore.CreateProcessingJob: %w", err)
	}
	return nil
}

// PostgresUploadStore implements UploadStore backed by PostgreSQL tables:
//
//	video_upload_sessions: status IN ('created','uploading','completed','aborted','expired')
//	  required NOT NULL: user_id, storage_provider, bucket, object_key, status, expires_at
//	videos: status IN ('uploading','processing','ready','failed','archived','deleted')
//	  visibility IN ('draft','unlisted','public','private')
//	  publish = status='ready' + visibility='public' + published_at set
//	comments: status IN ('visible','hidden','deleted','flagged')
type PostgresUploadStore struct {
	pool *pgxpool.Pool
}

func NewPostgresUploadStore(pool *pgxpool.Pool) *PostgresUploadStore {
	return &PostgresUploadStore{pool: pool}
}

// ── Upload Sessions ────────────────────────────────────────────────

func (s *PostgresUploadStore) CreateUpload(ctx context.Context, u Upload) error {
	objectKey := u.ObjectKey
	if objectKey == "" {
		objectKey = fmt.Sprintf("uploads/%s/%s", u.ID, sanitizeFilename(u.Filename))
	}
	bucket := u.Bucket
	if bucket == "" {
		bucket = "swypik-video-uploads"
	}
	storageProvider := u.StorageProvider
	if storageProvider == "" {
		storageProvider = "r2"
	}

	_, err := s.pool.Exec(ctx, `
		INSERT INTO video_upload_sessions
			(id, user_id, storage_provider, bucket, object_key, content_type,
			 byte_size, status, expires_at, created_at, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9, $10)
	`,
		u.ID,
		u.CreatorID,
		storageProvider,
		bucket,
		objectKey,
		u.ContentType,
		u.SizeBytes,
		u.ExpiresAt,
		u.CreatedAt,
		map[string]any{
			"filename":      u.Filename,
			"original_name": u.OriginalName,
			"product_id":    u.ProductID,
			"checksum_sha":  u.ChecksumSHA,
			"upload_url":    u.UploadURL,
		},
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.CreateUpload: %w", err)
	}
	return nil
}

func (s *PostgresUploadStore) GetUpload(ctx context.Context, id string) (Upload, error) {
	var u Upload
	var status string
	var metadata map[string]any
	var completedAt *time.Time
	var videoID *string

	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, storage_provider, bucket, object_key, content_type, byte_size, status,
		       expires_at, created_at, completed_at, video_id, metadata
		FROM video_upload_sessions WHERE id = $1
	`, id).Scan(
		&u.ID, &u.CreatorID, &u.StorageProvider, &u.Bucket, &u.ObjectKey, &u.ContentType, &u.SizeBytes, &status,
		&u.ExpiresAt, &u.CreatedAt, &completedAt, &videoID, &metadata,
	)
	if err == pgx.ErrNoRows {
		return Upload{}, fmt.Errorf("%w: upload %s", ErrNotFound, id)
	}
	if err != nil {
		return Upload{}, fmt.Errorf("videos.PostgresUploadStore.GetUpload: %w", err)
	}

	// Map DB status to service status
	switch status {
	case "completed":
		u.Status = UploadCompleted
	default:
		u.Status = UploadPending
	}
	if completedAt != nil {
		u.CompletedAt = *completedAt
	}
	if videoID != nil {
		u.VideoID = *videoID
	}
	if metadata != nil {
		if fn, ok := metadata["filename"].(string); ok {
			u.Filename = fn
		}
		if pid, ok := metadata["product_id"].(string); ok {
			u.ProductID = pid
		}
		if checksum, ok := metadata["checksum_sha"].(string); ok {
			u.ChecksumSHA = checksum
		}
		if originalName, ok := metadata["original_name"].(string); ok {
			u.OriginalName = originalName
		}
		if url, ok := metadata["upload_url"].(string); ok {
			u.UploadURL = url
		}
	}
	return u, nil
}

func (s *PostgresUploadStore) UpdateUpload(ctx context.Context, u Upload) error {
	// Map service status to DB status
	dbStatus := "created"
	if u.Status == UploadCompleted {
		dbStatus = "completed"
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE video_upload_sessions
		SET status = $1, video_id = $2, completed_at = $3
		WHERE id = $4
	`,
		dbStatus,
		nullStr(u.VideoID),
		nullTime(u.CompletedAt),
		u.ID,
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.UpdateUpload: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: upload %s", ErrNotFound, u.ID)
	}
	return nil
}

// ── Videos ─────────────────────────────────────────────────────────

func (s *PostgresUploadStore) CreateVideo(ctx context.Context, v Video) error {
	// Map service status to DB status
	// VideoReady → 'ready', not 'published' (published is not a valid DB status)
	dbStatus := "uploading"
	if v.Status == VideoProcessing {
		dbStatus = "processing"
	} else if v.Status == VideoReady || v.Status == VideoPublished {
		dbStatus = "ready"
	}

	productRefs := "[]"
	if v.ProductID != "" {
		productRefs = fmt.Sprintf(`[{"product_id": "%s"}]`, v.ProductID)
	}

	_, err := s.pool.Exec(ctx, `
		INSERT INTO videos
			(id, creator_id, title, description, playback_url, thumbnail_url,
			 duration_ms, visibility, status, product_refs, created_at)
		VALUES ($1, $2, '', '', $3, $4, $5, 'draft', $6, $7::jsonb, $8)
	`,
		v.ID,
		v.CreatorID,
		v.VideoURL,
		v.PosterURL,
		v.DurationMS,
		dbStatus,
		productRefs,
		v.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.CreateVideo: %w", err)
	}
	return nil
}

func (s *PostgresUploadStore) GetVideo(ctx context.Context, id string) (Video, error) {
	var v Video
	var status, visibility string
	var publishedAt *time.Time
	var playbackURL, thumbnailURL *string

	err := s.pool.QueryRow(ctx, `
		SELECT id, creator_id, playback_url, thumbnail_url,
		       duration_ms, visibility, status, published_at, created_at
		FROM videos WHERE id = $1
	`, id).Scan(
		&v.ID, &v.CreatorID, &playbackURL, &thumbnailURL,
		&v.DurationMS, &visibility, &status, &publishedAt, &v.CreatedAt,
	)
	if err == pgx.ErrNoRows {
		return Video{}, fmt.Errorf("%w: video %s", ErrNotFound, id)
	}
	if err != nil {
		return Video{}, fmt.Errorf("videos.PostgresUploadStore.GetVideo: %w", err)
	}

	v.VideoID = v.ID
	v.Visibility = VideoVisibility(visibility)
	if playbackURL != nil {
		v.VideoURL = *playbackURL
	}
	if thumbnailURL != nil {
		v.PosterURL = *thumbnailURL
	}
	if publishedAt != nil {
		v.PublishedAt = *publishedAt
	}

	// Map DB status+visibility to service status
	// In schema: published = status='ready' + visibility='public'
	if status == "ready" && visibility == "public" {
		v.Status = VideoPublished
	} else if status == "ready" {
		v.Status = VideoReady
	} else if status == "processing" {
		v.Status = VideoProcessing
	} else {
		v.Status = VideoUploading
	}

	return v, nil
}

func (s *PostgresUploadStore) UpdateVideo(ctx context.Context, v Video) error {
	// Publish: status stays 'ready', visibility → 'public', published_at set
	// The DB doesn't have 'published' as a valid status — publication is:
	//   status = 'ready' + visibility = 'public' + published_at IS NOT NULL
	dbStatus := "uploading"
	dbVisibility := "draft"
	if v.Status == VideoReady || v.Status == VideoPublished {
		dbStatus = "ready"
		if v.Visibility == VideoVisibilityPublic {
			dbVisibility = "public"
		}
	} else if v.Status == VideoProcessing {
		dbStatus = "processing"
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE videos
		SET playback_url = $1, thumbnail_url = $2, duration_ms = $3,
		    status = $4, visibility = $5, published_at = $6
		WHERE id = $7
	`,
		v.VideoURL, v.PosterURL, v.DurationMS,
		dbStatus, dbVisibility, nullTime(v.PublishedAt),
		v.ID,
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.UpdateVideo: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: video %s", ErrNotFound, v.ID)
	}
	return nil
}

// ── Comments ───────────────────────────────────────────────────────

func (s *PostgresUploadStore) CreateVideoAsset(ctx context.Context, asset VideoAsset) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO video_assets (
			id, video_id, asset_type, storage_provider, bucket, object_key,
			public_url, mime_type, byte_size, checksum_sha256, duration_ms,
			status, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
	`,
		asset.ID,
		asset.VideoID,
		string(asset.AssetType),
		asset.StorageProvider,
		asset.Bucket,
		asset.ObjectKey,
		nullStr(asset.PublicURL),
		nullStr(asset.MIMEType),
		nullInt64(asset.ByteSize),
		nullStr(asset.ChecksumSHA256),
		nullInt64(asset.DurationMS),
		string(asset.Status),
		asset.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.CreateVideoAsset: %w", err)
	}
	return nil
}

func (s *PostgresUploadStore) CreateProcessingJob(ctx context.Context, job ProcessingJob) error {
	payload, err := json.Marshal(job.Payload)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.CreateProcessingJob payload: %w", err)
	}

	_, err = s.pool.Exec(ctx, `
		INSERT INTO video_processing_jobs (
			id, video_id, asset_id, job_type, status, priority, attempt_count,
			max_attempts, scheduled_at, payload, created_at, updated_at
		) VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)
	`,
		job.ID,
		job.VideoID,
		job.AssetID,
		string(job.JobType),
		string(job.Status),
		job.Priority,
		job.AttemptCount,
		job.MaxAttempts,
		job.ScheduledAt,
		payload,
		job.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.CreateProcessingJob: %w", err)
	}
	return nil
}

func (s *PostgresUploadStore) ListComments(ctx context.Context, videoID string, limit, offset int) ([]Comment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, video_id, user_id, body, created_at
		FROM comments
		WHERE video_id = $1 AND status = 'visible'
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, videoID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("videos.PostgresUploadStore.ListComments: %w", err)
	}
	defer rows.Close()

	var comments []Comment
	for rows.Next() {
		var c Comment
		var userID *string
		if err := rows.Scan(&c.ID, &c.VideoID, &userID, &c.Body, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("videos.PostgresUploadStore.ListComments scan: %w", err)
		}
		if userID != nil {
			c.AuthorID = *userID
		}
		comments = append(comments, c)
	}
	return comments, rows.Err()
}

func (s *PostgresUploadStore) AddComment(ctx context.Context, c Comment) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO comments (id, video_id, user_id, body, status, created_at)
		VALUES ($1, $2, $3, $4, 'visible', $5)
	`, c.ID, c.VideoID, c.AuthorID, c.Body, c.CreatedAt)
	if err != nil {
		return fmt.Errorf("videos.PostgresUploadStore.AddComment: %w", err)
	}
	return nil
}

// ── Helpers ────────────────────────────────────────────────────────

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func nullInt64(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}
