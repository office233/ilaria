package feed

import (
	"context"
	"strings"
	"time"
)

type MemoryRepository struct {
	items []Item
}

func NewMemoryRepository(items []Item) *MemoryRepository {
	return &MemoryRepository{items: append([]Item(nil), items...)}
}

func (r *MemoryRepository) List(_ context.Context, query Query) ([]Item, error) {
	out := make([]Item, 0, len(r.items))
	for _, item := range r.items {
		if query.CategoryID != "" && item.CategoryID != query.CategoryID {
			continue
		}
		if query.CreatorID != "" && item.CreatorID != query.CreatorID {
			continue
		}
		out = append(out, item)
	}
	return out, nil
}

func DefaultItems() []Item {
	now := time.Now().UTC()
	return []Item{
		{
			ID:            "feed_1",
			ProductID:     "product_1",
			CreatorID:     "creator_1",
			CategoryID:    "beauty",
			Title:         "Curated launch clip",
			Description:   "Seed item for platform-api smoke tests.",
			HasVideo:      true,
			VideoURL:      "https://cdn.swypik.local/videos/feed_1.mp4",
			PosterURL:     "https://cdn.swypik.local/videos/feed_1.jpg",
			PriceRON:      9900,
			OldPriceRON:   12900,
			Rating:        4.8,
			OrdersCount:   250,
			LikesCount:    40,
			ViewsCount:    2000,
			CommentsCount: 12,
			PublishedAt:   now.Add(-6 * time.Hour),
		},
		{
			ID:          "feed_2",
			ProductID:   "product_2",
			CreatorID:   "creator_2",
			CategoryID:  "home",
			Title:       "Static product fallback",
			Description: strings.TrimSpace("Fallback content keeps /v1/feed useful before Postgres is wired."),
			PriceRON:    4900,
			Rating:      4.4,
			OrdersCount: 90,
			ViewsCount:  300,
			PublishedAt: now.Add(-24 * time.Hour),
		},
	}
}
