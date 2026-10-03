package feed

import (
	"os"
	"strings"
	"testing"
)

func TestPostgresRepositorySQLMatchesSocialMarketplaceMigration(t *testing.T) {
	source, err := os.ReadFile("postgres_repository.go")
	if err != nil {
		t.Fatalf("read repository source: %v", err)
	}
	sql := string(source)

	requiredFragments := []string{
		"FROM videos v",
		"v.status = 'ready'",
		"v.visibility = 'public'",
		"video_assets",
		"asset_type = 'transcoded'",
		"asset_type = 'source'",
		"asset_type = 'thumbnail'",
		"public_url",
		"status = 'available'",
		"video_product_links",
		"product_refs",
		"marketplace_products",
		"price_cents",
		"compare_at_price_cents",
	}
	for _, fragment := range requiredFragments {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("expected repository SQL to contain %q", fragment)
		}
	}

	forbiddenFragments := []string{
		"v.category_id",
		"video_products",
		"is_default",
		"hls_url",
		"mp4_url",
		"poster_url",
		"price_ron",
		"compare_at_price_ron",
		"orders_count",
		"rating",
		"v.status = 'published'",
	}
	for _, fragment := range forbiddenFragments {
		if strings.Contains(sql, fragment) {
			t.Fatalf("repository SQL still references old schema fragment %q", fragment)
		}
	}
}

func TestProductIDFromRefsPrefersLinksThenProductRefs(t *testing.T) {
	tests := []struct {
		name            string
		linkedProductID string
		productRefsJSON string
		want            string
	}{
		{
			name:            "linked product wins",
			linkedProductID: "linked-product",
			productRefsJSON: `[{"product_id":"ref-product"}]`,
			want:            "linked-product",
		},
		{
			name:            "string refs",
			productRefsJSON: `["ref-product","other-product"]`,
			want:            "ref-product",
		},
		{
			name:            "object product_id refs",
			productRefsJSON: `[{"product_id":"ref-product"},{"id":"other-product"}]`,
			want:            "ref-product",
		},
		{
			name:            "object id refs",
			productRefsJSON: `[{"id":"ref-product"}]`,
			want:            "ref-product",
		},
		{
			name:            "numeric refs",
			productRefsJSON: `[12345]`,
			want:            "12345",
		},
		{
			name:            "invalid refs",
			productRefsJSON: `not-json`,
			want:            "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := productIDFromRefs(tt.linkedProductID, tt.productRefsJSON); got != tt.want {
				t.Fatalf("productIDFromRefs() = %q, want %q", got, tt.want)
			}
		})
	}
}
