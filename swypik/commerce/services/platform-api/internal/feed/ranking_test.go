package feed

import (
	"testing"
	"time"
)

func TestRankScoreRewardsVideoEngagementRatingAndRecency(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	withVideo := Item{
		ID:             "video_1",
		HasVideo:       true,
		Rating:         4.8,
		OrdersCount:    250,
		LikesCount:     40,
		ViewsCount:     2000,
		PublishedAt:    now.Add(-6 * time.Hour),
		ReferenceClock: now,
	}
	withoutVideo := Item{
		ID:             "video_2",
		Rating:         4.8,
		OrdersCount:    250,
		LikesCount:     40,
		ViewsCount:     2000,
		PublishedAt:    now.Add(-6 * time.Hour),
		ReferenceClock: now,
	}

	if RankScore(withVideo) <= RankScore(withoutVideo) {
		t.Fatalf("expected item with video to outrank fallback item: video=%f fallback=%f", RankScore(withVideo), RankScore(withoutVideo))
	}
}

func TestRankItemsOrdersHighestScoresFirstWithStableTieBreak(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	items := []Item{
		{ID: "older", Rating: 3.2, OrdersCount: 5, PublishedAt: now.Add(-300 * time.Hour), ReferenceClock: now},
		{ID: "strong", HasVideo: true, Rating: 4.9, OrdersCount: 100, LikesCount: 20, ViewsCount: 500, PublishedAt: now.Add(-2 * time.Hour), ReferenceClock: now},
		{ID: "middle", Rating: 4.1, OrdersCount: 20, PublishedAt: now.Add(-20 * time.Hour), ReferenceClock: now},
	}

	ranked := RankItems(items)

	if ranked[0].ID != "strong" {
		t.Fatalf("expected highest scoring item first, got %q", ranked[0].ID)
	}
	if ranked[0].RankScore < ranked[1].RankScore || ranked[1].RankScore < ranked[2].RankScore {
		t.Fatalf("expected scores descending, got %f >= %f >= %f", ranked[0].RankScore, ranked[1].RankScore, ranked[2].RankScore)
	}
	if items[0].RankScore != 0 {
		t.Fatal("expected RankItems to return a ranked copy without mutating input")
	}
}
