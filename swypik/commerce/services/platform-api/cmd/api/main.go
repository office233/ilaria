package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/office233/swypik/services/platform-api/internal/checkout"
	"github.com/office233/swypik/services/platform-api/internal/events"
	"github.com/office233/swypik/services/platform-api/internal/feed"
	"github.com/office233/swypik/services/platform-api/internal/moderation"
	"github.com/office233/swypik/services/platform-api/internal/platform/config"
	"github.com/office233/swypik/services/platform-api/internal/platform/db"
	platformhttp "github.com/office233/swypik/services/platform-api/internal/platform/http"
	"github.com/office233/swypik/services/platform-api/internal/platform/logger"
	"github.com/office233/swypik/services/platform-api/internal/platform/redis"
	"github.com/office233/swypik/services/platform-api/internal/social"
	"github.com/office233/swypik/services/platform-api/internal/videos"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// In production, Postgres and Redis are required. Fail fast on missing
	// configuration or connection errors instead of silently degrading to
	// in-memory / no-op stores (which causes data loss without alerts).
	isProd := strings.EqualFold(cfg.Environment, "production")

	// ── Database ───────────────────────────────────────────────────
	var dbChecker db.HealthChecker = db.NewNoop()
	var pgPool *db.Pool

	if cfg.DatabaseURL != "" {
		connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		pool, err := db.New(connectCtx, db.DefaultConfig(cfg.DatabaseURL), log)
		cancel()
		if err != nil {
			if isProd {
				log.Error("FATAL: postgres unavailable in production", "error", err)
				os.Exit(1)
			}
			log.Warn("postgres unavailable, running with in-memory stores", "error", err)
		} else {
			pgPool = pool
			dbChecker = pool
			defer pool.Close()
		}
	} else {
		if isProd {
			log.Error("FATAL: DATABASE_URL is required in production")
			os.Exit(1)
		}
		log.Info("DATABASE_URL not set, running with in-memory stores")
	}

	// ── Redis ──────────────────────────────────────────────────────
	// Redis powers the events publisher (Redis Streams) and the video upload
	// job stream. In production these must be available; otherwise events and
	// video processing are silently dropped.
	var redisClient redis.Client = redis.NewNoop()

	if cfg.RedisURL != "" {
		connectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		rc, err := redis.New(connectCtx, redis.DefaultConfig(cfg.RedisURL), log)
		cancel()
		if err != nil {
			if isProd {
				log.Error("FATAL: redis unavailable in production", "error", err)
				os.Exit(1)
			}
			log.Warn("redis unavailable, running without streams/cache", "error", err)
		} else {
			redisClient = rc
			defer rc.Close()
		}
	} else {
		if isProd {
			log.Error("FATAL: REDIS_URL is required in production")
			os.Exit(1)
		}
		log.Info("REDIS_URL not set, running without streams/cache")
	}

	// 2026-08-15 (audit): webhook-ul Stripe se autentifică prin semnătură HMAC,
	// deci nu mai trece prin secretul intern. Dacă STRIPE_WEBHOOK_SECRET
	// lipsește, validSignature() returnează mereu false → TOATE evenimentele
	// de plată ar fi respinse tăcut, la runtime. Preferăm să nu pornim deloc
	// decât să pierdem plăți fără ca cineva să observe.
	if isProd && strings.TrimSpace(cfg.StripeWebhookSecret) == "" {
		log.Error("FATAL: STRIPE_WEBHOOK_SECRET is required in production (webhook-urile de plată ar fi respinse silențios)")
		os.Exit(1)
	}

	// ── Repositories ──────────────────────────────────────────────
	var feedRepo feed.Repository
	var socialStore social.Store
	var eventsStore events.Store
	var eventsPublisher events.Publisher
	var videoStore videos.UploadStore
	var checkoutStore checkout.Store
	var moderationSvc *moderation.Service

	if pgPool != nil {
		feedRepo = feed.NewPostgresRepository(pgPool.Pool())
		socialStore = social.NewPostgresStore(pgPool.Pool())
		eventsStore = events.NewPostgresStore(pgPool.Pool())
		videoStore = videos.NewPostgresUploadStore(pgPool.Pool())
		checkoutStore = checkout.NewPostgresStore(pgPool.Pool())
		pgMod := moderation.NewPostgresService(pgPool.Pool())
		_ = pgMod // moderation uses PostgresService.ListCases directly
		log.Info("repositories: using PostgreSQL")
	} else {
		log.Info("repositories: using in-memory (no DB)")
	}

	if rc, ok := redisClient.(*redis.RedisClient); ok && rc.Enabled() {
		eventsPublisher = events.NewRedisPublisher(rc, cfg.RedisStreamEvents, log)
		log.Info("events publisher: Redis Streams")
	}

	// ── HTTP Server ────────────────────────────────────────────────
	router := platformhttp.NewRouter(platformhttp.Dependencies{
		Config: cfg,
		Logger: log,
		Feed:   feed.NewService(feedRepo, time.Now),
		Events: events.NewService(eventsStore, eventsPublisher),
		Videos: videos.NewUploadService(videoStore, videos.UploadConfig{
			PublicUploadBaseURL: cfg.PublicUploadBaseURL,
			UploadTTL:           cfg.UploadTTL,
			StorageProvider:     cfg.S3StorageProvider,
			Bucket:              cfg.S3MediaBucket,
			Redis:               redisClient,
			RedisStream:         cfg.RedisStreamVideoJobs,
			Clock:               time.Now,
		}),
		Social:     social.NewService(socialStore, time.Now),
		Checkout:   checkout.NewService(checkoutStore, time.Now),
		Moderation: moderationSvc,
		DB:         dbChecker,
		Redis:      redisClient,
	})

	server := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Info("swypik-api listening",
			"addr", server.Addr,
			"env", cfg.Environment,
			"postgres", dbChecker.Enabled(),
			"redis", redisClient.Enabled(),
		)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("http shutdown failed", "error", err)
		os.Exit(1)
	}
	log.Info("swypik-api stopped gracefully")
}
