package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresRepository reads public feed items from the current social commerce tables.
type PostgresRepository struct {
	pool *pgxpool.Pool
}

func productIDFromRefs(linkedProductID, productRefsJSON string) string {
	if linkedProductID != "" {
		return linkedProductID
	}
	if productRefsJSON == "" {
		return ""
	}
	var refs []any
	if err := json.Unmarshal([]byte(productRefsJSON), &refs); err != nil {
		return ""
	}
	for _, ref := range refs {
		switch value := ref.(type) {
		case string:
			if value != "" {
				return value
			}
		case float64:
			return fmt.Sprintf("%.0f", value)
		case map[string]any:
			if id, ok := value["id"].(string); ok && id != "" {
				return id
			}
			if id, ok := value["product_id"].(string); ok && id != "" {
				return id
			}
		}
	}
	return ""
}

// NewPostgresRepository creates a repository backed by pgx pool.
func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// List fetches public videos joined with product and asset data.
func (r *PostgresRepository) List(ctx context.Context, query Query) ([]Item, error) {
	const baseQuery = `
		SELECT
			v.id,
			COALESCE(v.title, '') AS title,
			COALESCE(v.description, '') AS description,
			v.creator_id,
			'' AS category_id,
			v.status,
			v.visibility,
			v.published_at,
			v.view_count,
			v.like_count,
			v.comment_count,
			v.share_count,
			v.save_count,
			COALESCE(transcoded_asset.public_url, source_asset.public_url, v.playback_url, '') AS playback_url,
			COALESCE(thumbnail_asset.public_url, v.thumbnail_url, '') AS thumbnail_url,
			COALESCE(vpl.product_id::text, '') AS product_id,
			COALESCE(v.product_refs::text, '[]') AS product_refs,
			COALESCE(mp.price_cents, 0) AS price_cents,
			COALESCE(mp.compare_at_price_cents, 0) AS old_price_cents
		FROM videos v
		LEFT JOIN video_assets transcoded_asset
			ON transcoded_asset.video_id = v.id
			AND transcoded_asset.asset_type = 'transcoded'
			AND transcoded_asset.status = 'available'
		LEFT JOIN video_assets source_asset
			ON source_asset.video_id = v.id
			AND source_asset.asset_type = 'source'
			AND source_asset.status = 'available'
		LEFT JOIN video_assets thumbnail_asset
			ON thumbnail_asset.video_id = v.id
			AND thumbnail_asset.asset_type = 'thumbnail'
			AND thumbnail_asset.status = 'available'
		LEFT JOIN video_product_links vpl ON vpl.video_id = v.id AND vpl.sort_order = 0
		LEFT JOIN marketplace_products mp ON mp.id = vpl.product_id
		WHERE v.status = 'ready'
		  AND v.visibility = 'public'`

	args := make([]any, 0, 2)
	conditions := ""
	argIdx := 0

	if query.CategoryID != "" {
		argIdx++
		conditions += fmt.Sprintf(` AND EXISTS (
			SELECT 1 FROM video_product_links vpl2
			JOIN marketplace_products mp2 ON mp2.id = vpl2.product_id
			WHERE vpl2.video_id = v.id AND mp2.category = $%d
		)`, argIdx)
		args = append(args, query.CategoryID)
	}
	if query.CreatorID != "" {
		argIdx++
		conditions += fmt.Sprintf(" AND v.creator_id = $%d", argIdx)
		args = append(args, query.CreatorID)
	}

	candidateLimit := min(query.Offset+query.Limit*3, 500)
	argIdx++
	fullQuery := baseQuery + conditions +
		fmt.Sprintf(" ORDER BY v.published_at DESC NULLS LAST LIMIT $%d", argIdx)
	args = append(args, candidateLimit)

	rows, err := r.pool.Query(ctx, fullQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("feed.PostgresRepository.List: %w", err)
	}
	defer rows.Close()

	items := make([]Item, 0, candidateLimit)
	for rows.Next() {
		var (
			item                      Item
			status, visibility        string
			publishedAt               *time.Time
			viewCount, likeCount      int
			commentCount, shareCount  int
			saveCount                 int
			priceCents, oldPriceCents int
			playbackURL, thumbnailURL string
			linkedProductID           string
			productRefsJSON           string
		)

		err := rows.Scan(
			&item.ID,
			&item.Title,
			&item.Description,
			&item.CreatorID,
			&item.CategoryID,
			&status,
			&visibility,
			&publishedAt,
			&viewCount,
			&likeCount,
			&commentCount,
			&shareCount,
			&saveCount,
			&playbackURL,
			&thumbnailURL,
			&linkedProductID,
			&productRefsJSON,
			&priceCents,
			&oldPriceCents,
		)
		if err != nil {
			return nil, fmt.Errorf("feed.PostgresRepository.List scan: %w", err)
		}

		if playbackURL != "" {
			item.VideoURL = playbackURL
			item.HasVideo = true
		}
		item.ThumbnailURL = thumbnailURL
		item.PosterURL = thumbnailURL
		item.ViewsCount = viewCount
		item.LikesCount = likeCount
		item.CommentsCount = commentCount
		item.ProductID = productIDFromRefs(linkedProductID, productRefsJSON)
		item.OrdersCount = 0
		item.PriceRON = priceCents
		item.OldPriceRON = oldPriceCents
		item.Rating = 0

		if publishedAt != nil {
			item.PublishedAt = *publishedAt
		}

		items = append(items, item)
	}

	if rows.Err() != nil {
		return nil, fmt.Errorf("feed.PostgresRepository.List rows: %w", rows.Err())
	}

	return items, nil
}
