package moderation

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresService reads moderation cases from the moderation_cases table.
type PostgresService struct {
	pool *pgxpool.Pool
}

func NewPostgresService(pool *pgxpool.Pool) *PostgresService {
	return &PostgresService{pool: pool}
}

func (s *PostgresService) ListCases(ctx context.Context) ([]Case, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, 
		       COALESCE(target_video_id::text, target_user_id::text, target_comment_id::text, '') as subject_id,
		       CASE 
		           WHEN target_video_id IS NOT NULL THEN 'video'
		           WHEN target_user_id IS NOT NULL THEN 'user'
		           WHEN target_comment_id IS NOT NULL THEN 'comment'
		           ELSE 'unknown'
		       END as subject_type,
		       COALESCE(decision, '') as reason,
		       status,
		       COALESCE(severity, 'normal') as priority,
		       created_at
		FROM moderation_cases
		ORDER BY created_at DESC
		LIMIT 100
	`)
	if err != nil {
		return nil, fmt.Errorf("moderation.PostgresService.ListCases: %w", err)
	}
	defer rows.Close()

	var cases []Case
	for rows.Next() {
		var c Case
		var status string
		if err := rows.Scan(&c.ID, &c.SubjectID, &c.SubjectType, &c.Reason, &status, &c.Priority, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("moderation.PostgresService.ListCases scan: %w", err)
		}
		c.Status = CaseStatus(status)
		cases = append(cases, c)
	}
	return cases, rows.Err()
}
