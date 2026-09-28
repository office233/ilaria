package platformhttp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/office233/swypik/services/platform-api/internal/checkout"
	"github.com/office233/swypik/services/platform-api/internal/events"
	"github.com/office233/swypik/services/platform-api/internal/feed"
	"github.com/office233/swypik/services/platform-api/internal/moderation"
	"github.com/office233/swypik/services/platform-api/internal/platform/config"
	"github.com/office233/swypik/services/platform-api/internal/platform/db"
	"github.com/office233/swypik/services/platform-api/internal/platform/redis"
	"github.com/office233/swypik/services/platform-api/internal/social"
	"github.com/office233/swypik/services/platform-api/internal/videos"
)

const maxJSONBodyBytes = 1 << 20

type Dependencies struct {
	Config     config.Config
	Logger     *slog.Logger
	Feed       *feed.Service
	Events     *events.Service
	Videos     *videos.UploadService
	Social     *social.Service
	Checkout   *checkout.Service
	Moderation *moderation.Service
	DB         db.HealthChecker
	Redis      redis.Client
}

type API struct {
	cfg               config.Config
	log               *slog.Logger
	feedService       *feed.Service
	eventsService     *events.Service
	videosService     *videos.UploadService
	socialService     *social.Service
	checkoutService   *checkout.Service
	moderationService *moderation.Service
	db                db.HealthChecker
	redis             redis.Client
}

func NewRouter(deps Dependencies) http.Handler {
	api := newAPI(deps)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", api.healthz)
	mux.HandleFunc("GET /readyz", api.readyz)
	mux.HandleFunc("GET /v1/feed", api.feed)
	mux.HandleFunc("POST /v1/events/batch", api.eventsBatch)
	mux.HandleFunc("POST /v1/videos/{id}/publish", api.videoPublish)
	mux.HandleFunc("POST /v1/social/follow", api.follow)
	mux.HandleFunc("POST /v1/social/unfollow", api.unfollow)
	mux.HandleFunc("POST /v1/social/like", api.like)
	mux.HandleFunc("POST /v1/social/unlike", api.unlike)
	mux.HandleFunc("POST /v1/social/share", api.share)
	mux.HandleFunc("GET /v1/videos/{id}/comments", api.comments)
	mux.HandleFunc("POST /v1/videos/{id}/comments", api.addComment)
	mux.HandleFunc("POST /v1/cart/items", api.addCartItem)
	mux.HandleFunc("POST /v1/checkout", api.checkoutSession)
	mux.HandleFunc("POST /v1/payments/webhooks/stripe", api.stripeWebhook)
	mux.HandleFunc("GET /v1/admin/moderation/cases", api.moderationCases)

	return recoveryMiddleware(api.log)(requestIDMiddleware(corsMiddleware(api.cfg.CORSOrigins)(internalAuthMiddleware(api.cfg)(mux))))
}

func newAPI(deps Dependencies) *API {
	cfg := deps.Config
	if cfg.Host == "" || cfg.Port == 0 {
		cfg = config.Load()
	}
	log := deps.Logger
	if log == nil {
		log = slog.Default()
	}
	if deps.Feed == nil {
		deps.Feed = feed.NewService(nil, time.Now)
	}
	if deps.Events == nil {
		deps.Events = events.NewService(nil, nil)
	}
	if deps.Redis == nil {
		deps.Redis = redis.NewNoop()
	}
	if deps.Videos == nil {
		deps.Videos = videos.NewUploadService(nil, videos.UploadConfig{
			PublicUploadBaseURL: cfg.PublicUploadBaseURL,
			UploadTTL:           cfg.UploadTTL,
			StorageProvider:     cfg.S3StorageProvider,
			Bucket:              cfg.S3MediaBucket,
			Redis:               deps.Redis,
			RedisStream:         cfg.RedisStreamVideoJobs,
			Clock:               time.Now,
		})
	}
	if deps.Social == nil {
		deps.Social = social.NewService(nil, time.Now)
	}
	if deps.Checkout == nil {
		deps.Checkout = checkout.NewService(nil, time.Now)
	}
	if deps.Moderation == nil {
		deps.Moderation = moderation.NewService(nil)
	}
	if deps.DB == nil {
		deps.DB = db.NewNoop()
	}
	return &API{
		cfg:               cfg,
		log:               log,
		feedService:       deps.Feed,
		eventsService:     deps.Events,
		videosService:     deps.Videos,
		socialService:     deps.Social,
		checkoutService:   deps.Checkout,
		moderationService: deps.Moderation,
		db:                deps.DB,
		redis:             deps.Redis,
	}
}

func (a *API) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": "swypik-api",
	})
}

func (a *API) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	postgres := checkDependency(ctx, a.db)
	redisStatus := checkDependency(ctx, a.redis)
	status := http.StatusOK
	if postgres == "unavailable" || redisStatus == "unavailable" {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{
		"status":   ternary(status == http.StatusOK, "ready", "not_ready"),
		"postgres": postgres,
		"redis":    redisStatus,
	})
}

func (a *API) feed(w http.ResponseWriter, r *http.Request) {
	query := feed.Query{
		Limit:      parseBoundedInt(r.URL.Query().Get("limit"), 24, 1, 100),
		Offset:     parseBoundedInt(r.URL.Query().Get("offset"), 0, 0, 10_000),
		CategoryID: strings.TrimSpace(r.URL.Query().Get("category_id")),
		CreatorID:  strings.TrimSpace(r.URL.Query().Get("creator_id")),
	}
	page, err := a.feedService.List(r.Context(), query)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *API) eventsBatch(w http.ResponseWriter, r *http.Request) {
	var req events.Batch
	if !decodeRequest(w, r, &req) {
		return
	}
	result, err := a.eventsService.RecordBatch(r.Context(), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (a *API) videoPublish(w http.ResponseWriter, r *http.Request) {
	var req videos.PublishInput
	if !decodeRequest(w, r, &req) {
		return
	}
	video, err := a.videosService.Publish(r.Context(), r.PathValue("id"), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"video": video})
}

func (a *API) follow(w http.ResponseWriter, r *http.Request) {
	a.followState(w, r, true)
}

func (a *API) unfollow(w http.ResponseWriter, r *http.Request) {
	a.followState(w, r, false)
}

func (a *API) followState(w http.ResponseWriter, r *http.Request, shouldFollow bool) {
	var req social.FollowInput
	if !decodeRequest(w, r, &req) {
		return
	}
	var (
		result social.FollowResult
		err    error
	)
	if shouldFollow {
		result, err = a.socialService.Follow(r.Context(), req)
	} else {
		result, err = a.socialService.Unfollow(r.Context(), req)
	}
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) like(w http.ResponseWriter, r *http.Request) {
	a.likeState(w, r, true)
}

func (a *API) unlike(w http.ResponseWriter, r *http.Request) {
	a.likeState(w, r, false)
}

func (a *API) likeState(w http.ResponseWriter, r *http.Request, shouldLike bool) {
	var req social.LikeInput
	if !decodeRequest(w, r, &req) {
		return
	}
	var (
		result social.LikeResult
		err    error
	)
	if shouldLike {
		result, err = a.socialService.LikeVideo(r.Context(), req)
	} else {
		result, err = a.socialService.UnlikeVideo(r.Context(), req)
	}
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) share(w http.ResponseWriter, r *http.Request) {
	var req social.ShareInput
	if !decodeRequest(w, r, &req) {
		return
	}
	result, err := a.socialService.ShareVideo(r.Context(), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (a *API) comments(w http.ResponseWriter, r *http.Request) {
	comments, err := a.videosService.ListComments(
		r.Context(),
		r.PathValue("id"),
		parseBoundedInt(r.URL.Query().Get("limit"), 25, 1, 100),
		parseBoundedInt(r.URL.Query().Get("offset"), 0, 0, 10_000),
	)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": comments})
}

func (a *API) addComment(w http.ResponseWriter, r *http.Request) {
	var req videos.AddCommentInput
	if !decodeRequest(w, r, &req) {
		return
	}
	comment, err := a.videosService.AddComment(r.Context(), r.PathValue("id"), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, comment)
}

func (a *API) addCartItem(w http.ResponseWriter, r *http.Request) {
	var req checkout.AddCartItemInput
	if !decodeRequest(w, r, &req) {
		return
	}
	item, err := a.checkoutService.AddCartItem(r.Context(), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) checkoutSession(w http.ResponseWriter, r *http.Request) {
	var req checkout.CheckoutInput
	if !decodeRequest(w, r, &req) {
		return
	}
	result, err := a.checkoutService.Checkout(r.Context(), req)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (a *API) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	signature := r.Header.Get("Stripe-Signature")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodyBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "request body could not be read")
		return
	}
	result, err := a.checkoutService.RecordStripeWebhook(r.Context(), body, signature, a.cfg.StripeWebhookSecret)
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (a *API) moderationCases(w http.ResponseWriter, r *http.Request) {
	cases, err := a.moderationService.ListCases(r.Context())
	if err != nil {
		a.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": cases})
}

func decodeRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := requireJSON(r); err != nil {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", err.Error())
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_json", "body must contain exactly one JSON object")
		return false
	}
	return true
}

func requireJSON(r *http.Request) error {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return errors.New("Content-Type must be application/json")
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "application/json" {
		return errors.New("Content-Type must be application/json")
	}
	return nil
}

func (a *API) writeDomainError(w http.ResponseWriter, err error) {
	a.log.Warn("request failed", "error", err)
	switch {
	case errors.Is(err, events.ErrValidation), errors.Is(err, videos.ErrValidation), errors.Is(err, social.ErrValidation), errors.Is(err, checkout.ErrValidation):
		writeError(w, http.StatusBadRequest, "validation_failed", err.Error())
	case errors.Is(err, videos.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, videos.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "request failed")
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func parseBoundedInt(raw string, fallback, low, high int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func checkDependency(ctx context.Context, dependency interface {
	Enabled() bool
	Ping(context.Context) error
}) string {
	if dependency == nil || !dependency.Enabled() {
		return "disabled"
	}
	if err := dependency.Ping(ctx); err != nil {
		return "unavailable"
	}
	return "ok"
}

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if strings.TrimSpace(id) == "" {
			id = fmt.Sprintf("req_%d", time.Now().UnixNano())
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(origins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (slices.Contains(origins, "*") || slices.Contains(origins, origin)) {
				w.Header().Set("Access-Control-Allow-Origin", ternary(slices.Contains(origins, "*"), "*", origin))
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID, X-Swypik-Internal-Secret")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func internalAuthMiddleware(cfg config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !requiresInternalAuth(r) {
				next.ServeHTTP(w, r)
				return
			}

			secret := strings.TrimSpace(cfg.PlatformAPISecret)
			if secret == "" {
				if cfg.IsDev() {
					next.ServeHTTP(w, r)
					return
				}
				writeError(w, http.StatusServiceUnavailable, "misconfigured", "internal API secret is required")
				return
			}

			if !isInternalSecretProvided(r, secret) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "internal API secret is required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isInternalSecretProvided(r *http.Request, secret string) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Swypik-Internal-Secret"))
	if provided == "" {
		if auth := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(auth, "Bearer ") {
			provided = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		}
	}
	if len(provided) != len(secret) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(secret)) == 1
}

func requiresInternalAuth(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/v1/admin/") {
		return true
	}
	// 2026-08-15 (audit): webhook-urile de la procesatorii de plăți NU pot
	// trimite X-Swypik-Internal-Secret — ele se autentifică prin semnătură
	// HMAC, verificată în handler (vezi stripeWebhook → RecordStripeWebhook,
	// care validează Stripe-Signature + fereastra anti-replay de ±5 min).
	// Fără excepția asta, orice webhook Stripe primea 401 și evenimentul de
	// plată se pierdea tăcut.
	if isSignatureAuthenticatedWebhook(r.URL.Path) {
		return false
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

// isSignatureAuthenticatedWebhook enumeră explicit (allow-list, nu prefix
// generic) rutele care își fac singure verificarea criptografică de
// autenticitate. Lista e închisă intenționat: o rută nouă trebuie adăugată
// conștient aici, altfel rămâne protejată implicit de secretul intern.
func isSignatureAuthenticatedWebhook(path string) bool {
	switch path {
	case "/v1/payments/webhooks/stripe":
		return true
	default:
		return false
	}
}

func recoveryMiddleware(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Error("panic recovered", "error", recovered, "path", r.URL.Path)
					writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func ternary[T any](condition bool, ifTrue, ifFalse T) T {
	if condition {
		return ifTrue
	}
	return ifFalse
}
