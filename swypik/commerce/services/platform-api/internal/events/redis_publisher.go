package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
)

type redisStreamClient interface {
	Publish(context.Context, string, []byte) error
}

type RedisPublisher struct {
	client redisStreamClient
	stream string
	log    *slog.Logger
}

func NewRedisPublisher(client redisStreamClient, stream string, logs ...*slog.Logger) *RedisPublisher {
	if stream == "" {
		stream = defaultEventStreamName
	}
	log := slog.Default()
	if len(logs) > 0 && logs[0] != nil {
		log = logs[0]
	}
	return &RedisPublisher{client: client, stream: stream, log: log}
}

func (p *RedisPublisher) Publish(ctx context.Context, events []Event) error {
	if p.client == nil || len(events) == 0 {
		return nil
	}
	for _, event := range events {
		payload, err := json.Marshal(event)
		if err != nil {
			p.log.Warn("events.RedisPublisher: marshal failed", "event_id", event.ID, "err", err)
			continue
		}
		if err := p.client.Publish(ctx, p.stream, payload); err != nil {
			return fmt.Errorf("events.RedisPublisher.Publish: %w", err)
		}
	}
	return nil
}
