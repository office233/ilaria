// Package redis provides a Redis client that supports health checks and
// Redis Streams publishing for the platform event pipeline.
package redis

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// Client is the minimal interface the router uses for readiness checks
// and event publishing.
type Client interface {
	Enabled() bool
	Ping(context.Context) error
	Publish(context.Context, string, []byte) error
}

// Config holds Redis connection parameters.
type Config struct {
	URL          string
	MaxRetries   int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	PoolSize     int
}

// DefaultConfig returns sensible defaults for local dev.
func DefaultConfig(redisURL string) Config {
	return Config{
		URL:          redisURL,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     10,
	}
}

// RedisClient wraps go-redis and implements Client.
type RedisClient struct {
	rdb *goredis.Client
	log *slog.Logger
}

// New creates a connected Redis client. Returns error on initial ping failure.
func New(ctx context.Context, cfg Config, log *slog.Logger) (*RedisClient, error) {
	if cfg.URL == "" {
		return nil, fmt.Errorf("redis: REDIS_URL is required")
	}

	opts, err := goredis.ParseURL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("redis: parse url: %w", err)
	}
	opts.MaxRetries = cfg.MaxRetries
	opts.DialTimeout = cfg.DialTimeout
	opts.ReadTimeout = cfg.ReadTimeout
	opts.WriteTimeout = cfg.WriteTimeout
	opts.PoolSize = cfg.PoolSize

	rdb := goredis.NewClient(opts)

	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("redis: ping: %w", err)
	}

	log.Info("redis connected", "pool_size", opts.PoolSize)
	return &RedisClient{rdb: rdb, log: log}, nil
}

// Underlying returns the raw go-redis client for advanced operations
// like XADD, XREADGROUP, etc.
func (c *RedisClient) Underlying() *goredis.Client {
	return c.rdb
}

// Enabled returns true when a live connection exists.
func (c *RedisClient) Enabled() bool {
	return c != nil && c.rdb != nil
}

// Ping checks Redis connectivity.
func (c *RedisClient) Ping(ctx context.Context) error {
	if !c.Enabled() {
		return fmt.Errorf("redis: client is nil")
	}
	return c.rdb.Ping(ctx).Err()
}

// Publish pushes a message onto a Redis Stream using XADD.
// The stream name is used as the key and the payload is stored under
// the "data" field. This is the primary mechanism for the event pipeline.
func (c *RedisClient) Publish(ctx context.Context, stream string, data []byte) error {
	if !c.Enabled() {
		return fmt.Errorf("redis: client is nil")
	}
	return c.rdb.XAdd(ctx, &goredis.XAddArgs{
		Stream: stream,
		Values: map[string]interface{}{
			"data": string(data),
		},
	}).Err()
}

// Close shuts down the client. Call from graceful shutdown.
func (c *RedisClient) Close() error {
	if c != nil && c.rdb != nil {
		return c.rdb.Close()
	}
	return nil
}

// Noop is a no-op Client for when REDIS_URL is not configured.
type Noop struct{}

func NewNoop() Noop                                       { return Noop{} }
func (Noop) Enabled() bool                                { return false }
func (Noop) Ping(context.Context) error                   { return nil }
func (Noop) Publish(context.Context, string, []byte) error { return nil }
