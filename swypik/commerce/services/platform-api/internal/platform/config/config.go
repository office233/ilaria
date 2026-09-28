package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all platform-api configuration. Values are loaded from
// environment variables with sensible defaults for local development.
type Config struct {
	// Server
	Host              string
	Port              int
	Environment       string
	LogLevel          string
	CORSOrigins       []string
	PlatformAPISecret string

	// PostgreSQL
	DatabaseURL string

	// Redis
	RedisURL             string
	RedisStreamEvents    string
	RedisStreamVideoJobs string

	// Upload / S3 / R2
	PublicUploadBaseURL string
	UploadTTL           time.Duration
	S3StorageProvider   string
	S3Endpoint          string
	S3Region            string
	S3AccessKeyID       string
	S3SecretAccessKey   string
	S3MediaBucket       string
	S3ForcePathStyle    bool

	// Stripe
	StripeSecretKey     string
	StripeWebhookSecret string

	// ClickHouse
	ClickHouseURL string
}

// Load reads configuration from environment variables.
func Load() Config {
	environment := envOr("ENVIRONMENT", "development")
	return Config{
		// Server
		Host:              envOr("HOST", "0.0.0.0"),
		Port:              envIntOr("PORT", 8080),
		Environment:       environment,
		LogLevel:          envOr("LOG_LEVEL", "info"),
		CORSOrigins:       splitCSV(envOr("CORS_ALLOWED_ORIGINS", defaultCORSOrigins(environment))),
		PlatformAPISecret: os.Getenv("PLATFORM_API_SECRET"),

		// PostgreSQL
		DatabaseURL: os.Getenv("DATABASE_URL"),

		// Redis
		RedisURL:             os.Getenv("REDIS_URL"),
		RedisStreamEvents:    envOr("REDIS_STREAM_EVENTS", "social.events"),
		RedisStreamVideoJobs: envOr("REDIS_STREAM_VIDEO_JOBS", "video:jobs"),

		// Upload / S3 / R2
		PublicUploadBaseURL: strings.TrimRight(envAnyOr([]string{"MEDIA_PUBLIC_BASE_URL", "PUBLIC_UPLOAD_BASE_URL", "S3_PUBLIC_BASE_URL", "S3_PUBLIC_URL", "R2_PUBLIC_BASE_URL", "R2_PUBLIC_URL"}, "https://uploads.swypik.local"), "/"),
		UploadTTL:           time.Duration(envIntOr("UPLOAD_TTL_MINUTES", 15)) * time.Minute,
		S3StorageProvider:   envOr("S3_STORAGE_PROVIDER", "r2"),
		S3Endpoint:          envAny("S3_ENDPOINT", "S3_ENDPOINT_URL", "R2_ENDPOINT", "R2_ENDPOINT_URL"),
		S3Region:            envAnyOr([]string{"S3_REGION", "R2_REGION", "AWS_REGION"}, "auto"),
		S3AccessKeyID:       envAny("S3_ACCESS_KEY_ID", "S3_ACCESS_KEY", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
		S3SecretAccessKey:   envAny("S3_SECRET_ACCESS_KEY", "S3_SECRET_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
		S3MediaBucket:       envAnyOr([]string{"S3_MEDIA_BUCKET", "S3_BUCKET", "R2_BUCKET", "SOCIAL_MEDIA_BUCKET"}, "swypik-video-uploads"),
		S3ForcePathStyle:    envBoolOr("S3_FORCE_PATH_STYLE", true),

		// Stripe
		StripeSecretKey:     os.Getenv("STRIPE_SECRET_KEY"),
		StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),

		// ClickHouse
		ClickHouseURL: os.Getenv("CLICKHOUSE_URL"),
	}
}

// Addr returns the host:port address for http.Server.
func (c Config) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// IsDev returns true when running in development mode.
func (c Config) IsDev() bool {
	return c.Environment == "development" || c.Environment == ""
}

func defaultCORSOrigins(environment string) string {
	if environment == "production" {
		return "https://swypik.com,https://www.swypik.com"
	}
	return "*"
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envAny(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func envAnyOr(keys []string, fallback string) string {
	if value := envAny(keys...); value != "" {
		return value
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envBoolOr(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch raw {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return fallback
	}
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return []string{"*"}
	}
	return out
}
