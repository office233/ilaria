package social

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var ErrValidation = errors.New("validation failed")

type FollowInput struct {
	FollowerID string `json:"follower_id"`
	FolloweeID string `json:"followee_id"`
}

type FollowResult struct {
	FollowerID string    `json:"follower_id"`
	FolloweeID string    `json:"followee_id"`
	Following  bool      `json:"following"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type LikeInput struct {
	UserID  string `json:"user_id"`
	VideoID string `json:"video_id"`
}

type LikeResult struct {
	UserID    string    `json:"user_id"`
	VideoID   string    `json:"video_id"`
	Liked     bool      `json:"liked"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ShareInput struct {
	UserID  string `json:"user_id,omitempty"` // optional for anonymous
	VideoID string `json:"video_id"`
	Channel string `json:"channel"`
}

type ShareResult struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id,omitempty"`
	VideoID   string    `json:"video_id"`
	Channel   string    `json:"channel"`
	ShareToken string   `json:"share_token"`
	CreatedAt time.Time `json:"created_at"`
}

type Store interface {
	SetFollow(context.Context, string, string, bool, time.Time) (FollowResult, error)
	SetLike(context.Context, string, string, bool, time.Time) (LikeResult, error)
	RecordShare(context.Context, ShareResult) error
}

type Service struct {
	store Store
	clock func() time.Time
}

func NewService(store Store, clock func() time.Time) *Service {
	if store == nil {
		store = NewMemoryStore()
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{store: store, clock: clock}
}

func (s *Service) Follow(ctx context.Context, input FollowInput) (FollowResult, error) {
	followerID, followeeID, err := validateFollow(input)
	if err != nil {
		return FollowResult{}, err
	}
	return s.store.SetFollow(ctx, followerID, followeeID, true, s.clock().UTC())
}

func (s *Service) Unfollow(ctx context.Context, input FollowInput) (FollowResult, error) {
	followerID, followeeID, err := validateFollow(input)
	if err != nil {
		return FollowResult{}, err
	}
	return s.store.SetFollow(ctx, followerID, followeeID, false, s.clock().UTC())
}

func (s *Service) LikeVideo(ctx context.Context, input LikeInput) (LikeResult, error) {
	userID, videoID, err := validateLike(input)
	if err != nil {
		return LikeResult{}, err
	}
	return s.store.SetLike(ctx, userID, videoID, true, s.clock().UTC())
}

func (s *Service) UnlikeVideo(ctx context.Context, input LikeInput) (LikeResult, error) {
	userID, videoID, err := validateLike(input)
	if err != nil {
		return LikeResult{}, err
	}
	return s.store.SetLike(ctx, userID, videoID, false, s.clock().UTC())
}

func (s *Service) ShareVideo(ctx context.Context, input ShareInput) (ShareResult, error) {
	videoID := strings.TrimSpace(input.VideoID)
	channel := strings.TrimSpace(input.Channel)
	if videoID == "" {
		return ShareResult{}, validationError("video_id is required")
	}
	if channel == "" {
		return ShareResult{}, validationError("channel is required")
	}
	
	result := ShareResult{
		ID:         "shr_" + fmt.Sprintf("%d", s.clock().UnixNano()), // basic uuid alternative for now
		UserID:     strings.TrimSpace(input.UserID),
		VideoID:    videoID,
		Channel:    channel,
		ShareToken: fmt.Sprintf("tkn_%d", s.clock().UnixNano()),
		CreatedAt:  s.clock().UTC(),
	}
	err := s.store.RecordShare(ctx, result)
	if err != nil {
		return ShareResult{}, err
	}
	return result, nil
}

func validateFollow(input FollowInput) (string, string, error) {
	followerID := strings.TrimSpace(input.FollowerID)
	followeeID := strings.TrimSpace(input.FolloweeID)
	if followerID == "" {
		return "", "", validationError("follower_id is required")
	}
	if followeeID == "" {
		return "", "", validationError("followee_id is required")
	}
	if followerID == followeeID {
		return "", "", validationError("follower_id and followee_id must differ")
	}
	return followerID, followeeID, nil
}

func validateLike(input LikeInput) (string, string, error) {
	userID := strings.TrimSpace(input.UserID)
	videoID := strings.TrimSpace(input.VideoID)
	if userID == "" {
		return "", "", validationError("user_id is required")
	}
	if videoID == "" {
		return "", "", validationError("video_id is required")
	}
	return userID, videoID, nil
}

func validationError(message string) error {
	return fmt.Errorf("%w: %s", ErrValidation, message)
}

type MemoryStore struct {
	mu      sync.RWMutex
	follows map[string]FollowResult
	likes   map[string]LikeResult
	shares  map[string]ShareResult
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		follows: make(map[string]FollowResult),
		likes:   make(map[string]LikeResult),
		shares:  make(map[string]ShareResult),
	}
}

func (s *MemoryStore) SetFollow(_ context.Context, followerID, followeeID string, following bool, updatedAt time.Time) (FollowResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := followerID + "->" + followeeID
	result := FollowResult{
		FollowerID: followerID,
		FolloweeID: followeeID,
		Following:  following,
		UpdatedAt:  updatedAt,
	}
	if following {
		s.follows[key] = result
	} else {
		delete(s.follows, key)
	}
	return result, nil
}

func (s *MemoryStore) SetLike(_ context.Context, userID, videoID string, liked bool, updatedAt time.Time) (LikeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := userID + "->" + videoID
	result := LikeResult{
		UserID:    userID,
		VideoID:   videoID,
		Liked:     liked,
		UpdatedAt: updatedAt,
	}
	if liked {
		s.likes[key] = result
	} else {
		delete(s.likes, key)
	}
	return result, nil
}

func (s *MemoryStore) RecordShare(_ context.Context, share ShareResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.shares[share.ID] = share
	return nil
}
