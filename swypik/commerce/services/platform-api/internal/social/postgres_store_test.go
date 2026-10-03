package social

import (
	"strings"
	"testing"
)

func TestPostgresFollowSQLUsesSocialMarketplaceSchema(t *testing.T) {
	insertSQL := buildFollowInsertSQL()
	deleteSQL := buildFollowDeleteSQL()

	for _, sql := range []string{insertSQL, deleteSQL} {
		if !strings.Contains(sql, "follower_user_id") {
			t.Fatalf("follow SQL must use follower_user_id from social marketplace schema: %s", sql)
		}
		if !strings.Contains(sql, "following_user_id") {
			t.Fatalf("follow SQL must use following_user_id from social marketplace schema: %s", sql)
		}
		if strings.Contains(sql, "follower_id") || strings.Contains(sql, "following_id") {
			t.Fatalf("follow SQL still references old column names: %s", sql)
		}
	}
}
