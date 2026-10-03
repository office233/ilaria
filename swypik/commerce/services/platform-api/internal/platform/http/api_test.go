package platformhttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/office233/swypik/services/platform-api/internal/platform/config"
)

func TestInternalAPISecretDoesNotBlockHealth(t *testing.T) {
	router := NewRouter(Dependencies{
		Config: config.Config{
			Host:              "127.0.0.1",
			Port:              8080,
			CORSOrigins:       []string{"*"},
			PlatformAPISecret: "secret",
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected health without internal secret, got %d", rec.Code)
	}
}

func TestInternalAPISecretBlocksDirectMutations(t *testing.T) {
	router := NewRouter(Dependencies{
		Config: config.Config{
			Host:              "127.0.0.1",
			Port:              8080,
			CORSOrigins:       []string{"*"},
			PlatformAPISecret: "secret",
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/videos/00000000-0000-0000-0000-000000000001/publish", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized direct mutation, got %d", rec.Code)
	}
}

func TestProductionMutationsFailClosedWithoutInternalSecret(t *testing.T) {
	router := NewRouter(Dependencies{
		Config: config.Config{
			Host:        "127.0.0.1",
			Port:        8080,
			Environment: "production",
			CORSOrigins: []string{"https://swypik.com"},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/videos/00000000-0000-0000-0000-000000000001/publish", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected production mutation without internal secret to fail closed, got %d", rec.Code)
	}
}

func TestAdminGETRequiresInternalSecret(t *testing.T) {
	router := NewRouter(Dependencies{
		Config: config.Config{
			Host:              "127.0.0.1",
			Port:              8080,
			CORSOrigins:       []string{"*"},
			PlatformAPISecret: "secret",
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/admin/moderation/cases", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected admin read without internal secret to be unauthorized, got %d", rec.Code)
	}
}

func TestInternalAPISecretAllowsProxyMutations(t *testing.T) {
	router := NewRouter(Dependencies{
		Config: config.Config{
			Host:              "127.0.0.1",
			Port:              8080,
			CORSOrigins:       []string{"*"},
			PlatformAPISecret: "secret",
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/videos/00000000-0000-0000-0000-000000000001/publish", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Swypik-Internal-Secret", "secret")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code == http.StatusUnauthorized {
		t.Fatal("expected proxy mutation to pass internal secret check")
	}
}
