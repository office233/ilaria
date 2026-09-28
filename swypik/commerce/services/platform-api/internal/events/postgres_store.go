package events

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const defaultEventStreamName = "social.events"

type postgresDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type postgresStore struct {
	db postgresDB
}

func newPostgresStore(db postgresDB) *postgresStore {
	return &postgresStore{db: db}
}

func NewPostgresStore(db postgresDB) Store {
	return newPostgresStore(db)
}

func (s *postgresStore) Append(ctx context.Context, events []Event) error {
	for _, event := range events {
		payload, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("events.PostgresStore.Append marshal: %w", err)
		}
		aggregateID := nullableUUID(event.SubjectID)
		actorID := nullableUUID(event.ActorID)
		occurredAt := event.OccurredAt
		if occurredAt.IsZero() {
			occurredAt = time.Now().UTC()
		}
		_, err = s.db.Exec(ctx, `
INSERT INTO event_outbox (
	stream_name,
	event_type,
	aggregate_type,
	aggregate_id,
	actor_user_id,
	payload,
	occurred_at,
	metadata
) VALUES ($1, $2, $3, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid, $6::jsonb, $7, $8::jsonb)`,
			defaultEventStreamName,
			event.Type,
			event.SubjectType,
			aggregateID,
			actorID,
			string(payload),
			occurredAt,
			string(payload),
		)
		if err != nil {
			return fmt.Errorf("events.PostgresStore.Append: %w", err)
		}
	}
	return nil
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func nullableUUID(value string) string {
	if uuidRe.MatchString(value) {
		return value
	}
	return ""
}
