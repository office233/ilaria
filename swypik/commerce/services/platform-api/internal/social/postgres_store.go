package social

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore implements Store using the follows table in PostgreSQL.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore creates a PostgreSQL-backed social store.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

// SetFollow inserts or deletes a follow relationship.
// Uses ON CONFLICT for idempotent follow, and DELETE for unfollow.
func (s *PostgresStore) SetFollow(ctx context.Context, followerID, followeeID string, following bool, updatedAt time.Time) (FollowResult, error) {
	result := FollowResult{
		FollowerID: followerID,
		FolloweeID: followeeID,
		Following:  following,
		UpdatedAt:  updatedAt,
	}

	if following {
		_, err := s.pool.Exec(ctx, buildFollowInsertSQL(), followerID, followeeID, updatedAt)
		if err != nil {
			return FollowResult{}, fmt.Errorf("social.PostgresStore.SetFollow insert: %w", err)
		}
	} else {
		_, err := s.pool.Exec(ctx, buildFollowDeleteSQL(), followerID, followeeID)
		if err != nil {
			return FollowResult{}, fmt.Errorf("social.PostgresStore.SetFollow delete: %w", err)
		}
	}

	return result, nil
}

func buildFollowInsertSQL() string {
	return `
		INSERT INTO follows (follower_user_id, following_user_id, created_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (follower_user_id, following_user_id) DO NOTHING
	`
}

func buildFollowDeleteSQL() string {
	return `
		DELETE FROM follows
		WHERE follower_user_id = $1 AND following_user_id = $2
	`
}

func (s *PostgresStore) SetLike(ctx context.Context, userID, videoID string, liked bool, updatedAt time.Time) (LikeResult, error) {
	result := LikeResult{
		UserID:    userID,
		VideoID:   videoID,
		Liked:     liked,
		UpdatedAt: updatedAt,
	}

	if liked {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO likes (user_id, video_id, created_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (user_id, video_id) WHERE video_id IS NOT NULL DO NOTHING
		`, userID, videoID, updatedAt)
		if err != nil {
			return LikeResult{}, fmt.Errorf("social.PostgresStore.SetLike insert: %w", err)
		}
	} else {
		_, err := s.pool.Exec(ctx, `
			DELETE FROM likes
			WHERE user_id = $1 AND video_id = $2
		`, userID, videoID)
		if err != nil {
			return LikeResult{}, fmt.Errorf("social.PostgresStore.SetLike delete: %w", err)
		}
	}

	return result, nil
}

func (s *PostgresStore) RecordShare(ctx context.Context, share ShareResult) error {
	var err error
	if share.UserID != "" {
		_, err = s.pool.Exec(ctx, `
			INSERT INTO shares (user_id, video_id, channel, share_token, created_at)
			VALUES ($1, $2, $3, $4, $5)
		`, share.UserID, share.VideoID, share.Channel, share.ShareToken, share.CreatedAt)
	} else {
		_, err = s.pool.Exec(ctx, `
			INSERT INTO shares (video_id, channel, share_token, created_at)
			VALUES ($1, $2, $3, $4)
		`, share.VideoID, share.Channel, share.ShareToken, share.CreatedAt)
	}
	if err != nil {
		return fmt.Errorf("social.PostgresStore.RecordShare: %w", err)
	}
	return nil
}
