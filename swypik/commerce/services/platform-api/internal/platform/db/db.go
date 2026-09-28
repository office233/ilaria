// Package db provides PostgreSQL connection management via pgx.
package db

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// HealthChecker is the minimal interface checked by /readyz.
type HealthChecker interface {
	Enabled() bool
	Ping(context.Context) error
}

// Pool wraps a pgx connection pool and satisfies HealthChecker.
type Pool struct {
	pool *pgxpool.Pool
	log  *slog.Logger
}

// Config holds PostgreSQL connection parameters.
type Config struct {
	URL             string
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
}

// DefaultConfig returns sensible defaults suitable for a single‑node dev setup.
func DefaultConfig(databaseURL string) Config {
	return Config{
		URL:             databaseURL,
		MaxConns:        20,
		MinConns:        2,
		MaxConnLifetime: 30 * time.Minute,
		MaxConnIdleTime: 5 * time.Minute,
	}
}

// New creates a connected pool. It returns an error when the initial
// connection or ping fails so the caller can fail‑fast at startup.
func New(ctx context.Context, cfg Config, log *slog.Logger) (*Pool, error) {
	if cfg.URL == "" {
		return nil, fmt.Errorf("db: DATABASE_URL is required")
	}

	poolCfg, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("db: parse config: %w", err)
	}
	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	poolCfg.MaxConnLifetime = cfg.MaxConnLifetime
	poolCfg.MaxConnIdleTime = cfg.MaxConnIdleTime

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("db: connect: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}

	log.Info("postgres connected", "max_conns", cfg.MaxConns)
	return &Pool{pool: pool, log: log}, nil
}

// Pool returns the underlying pgxpool.Pool for repository queries.
func (p *Pool) Pool() *pgxpool.Pool {
	return p.pool
}

// Enabled returns true when a live pool exists.
func (p *Pool) Enabled() bool {
	return p != nil && p.pool != nil
}

// Ping verifies the database is reachable.
func (p *Pool) Ping(ctx context.Context) error {
	if !p.Enabled() {
		return fmt.Errorf("db: pool is nil")
	}
	return p.pool.Ping(ctx)
}

// Close drains connections. Call from graceful shutdown.
func (p *Pool) Close() {
	if p != nil && p.pool != nil {
		p.pool.Close()
	}
}

// Noop is a no‑op HealthChecker for when DATABASE_URL is not configured.
type Noop struct{}

func NewNoop() Noop   { return Noop{} }
func (Noop) Enabled() bool            { return false }
func (Noop) Ping(context.Context) error { return nil }
