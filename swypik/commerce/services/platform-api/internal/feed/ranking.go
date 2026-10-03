package feed

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"
)

type Item struct {
	ID             string    `json:"id"`
	ProductID      string    `json:"product_id,omitempty"`
	CreatorID      string    `json:"creator_id,omitempty"`
	CategoryID     string    `json:"category_id,omitempty"`
	Title          string    `json:"title,omitempty"`
	Description    string    `json:"description,omitempty"`
	HasVideo       bool      `json:"has_video"`
	VideoURL       string    `json:"video_url,omitempty"`
	PosterURL      string    `json:"poster_url,omitempty"`
	ThumbnailURL   string    `json:"thumbnail_url,omitempty"`
	PriceRON       int       `json:"price_ron,omitempty"`
	OldPriceRON    int       `json:"old_price_ron,omitempty"`
	Rating         float64   `json:"rating,omitempty"`
	OrdersCount    int       `json:"orders_count,omitempty"`
	LikesCount     int       `json:"likes_count,omitempty"`
	ViewsCount     int       `json:"views_count,omitempty"`
	CommentsCount  int       `json:"comments_count,omitempty"`
	PublishedAt    time.Time `json:"published_at,omitempty"`
	ReferenceClock time.Time `json:"-"`
	RankScore      float64   `json:"rank_score"`
}

type Query struct {
	Limit      int
	Offset     int
	CategoryID string
	CreatorID  string
}

type Page struct {
	Items  []Item `json:"items"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

type Repository interface {
	List(context.Context, Query) ([]Item, error)
}

type Service struct {
	repository Repository
	clock      func() time.Time
}

func NewService(repository Repository, clock func() time.Time) *Service {
	if repository == nil {
		repository = NewMemoryRepository(DefaultItems())
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{repository: repository, clock: clock}
}

func (s *Service) List(ctx context.Context, query Query) (Page, error) {
	query.Limit = boundedInt(query.Limit, 24, 1, 100)
	if query.Offset < 0 {
		query.Offset = 0
	}

	items, err := s.repository.List(ctx, query)
	if err != nil {
		return Page{}, err
	}
	now := s.clock().UTC()
	for idx := range items {
		if items[idx].ReferenceClock.IsZero() {
			items[idx].ReferenceClock = now
		}
	}
	ranked := RankItems(items)
	start := min(query.Offset, len(ranked))
	end := min(start+query.Limit, len(ranked))
	return Page{Items: ranked[start:end], Limit: query.Limit, Offset: query.Offset}, nil
}

func RankScore(item Item) float64 {
	score := 0.0
	if item.HasVideo || strings.TrimSpace(item.VideoURL) != "" {
		score += 30
	}
	score += clamp(item.Rating, 0, 5) * 8
	score += math.Log1p(float64(max(item.OrdersCount, 0))) * 4
	score += math.Log1p(float64(max(item.LikesCount, 0))) * 5
	score += math.Log1p(float64(max(item.ViewsCount, 0))) * 1.5
	score += math.Log1p(float64(max(item.CommentsCount, 0))) * 2

	if item.PriceRON > 0 && item.OldPriceRON > item.PriceRON {
		discount := float64(item.OldPriceRON-item.PriceRON) / float64(item.OldPriceRON)
		score += clamp(discount, 0, 0.8) * 18
	}
	score += recencyBoost(item.ageHours())
	return math.Round(score*1000) / 1000
}

func RankItems(items []Item) []Item {
	ranked := append([]Item(nil), items...)
	for idx := range ranked {
		ranked[idx].RankScore = RankScore(ranked[idx])
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].RankScore == ranked[j].RankScore {
			if !ranked[i].PublishedAt.Equal(ranked[j].PublishedAt) {
				return ranked[i].PublishedAt.After(ranked[j].PublishedAt)
			}
			return ranked[i].ID > ranked[j].ID
		}
		return ranked[i].RankScore > ranked[j].RankScore
	})
	return ranked
}

func (i Item) ageHours() float64 {
	if i.PublishedAt.IsZero() {
		return 0
	}
	now := i.ReferenceClock
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if i.PublishedAt.After(now) {
		return 0
	}
	return now.Sub(i.PublishedAt).Hours()
}

func recencyBoost(ageHours float64) float64 {
	if ageHours <= 0 {
		return 8
	}
	if ageHours >= 24*30 {
		return 0
	}
	return 8 * math.Exp(-ageHours/(24*7))
}

func clamp(value, low, high float64) float64 {
	return math.Max(low, math.Min(high, value))
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
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
