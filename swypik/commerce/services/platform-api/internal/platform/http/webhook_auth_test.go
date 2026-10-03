package platformhttp

import (
	"net/http"
	"testing"
)

// Regresie 2026-08-15: `requiresInternalAuth` returna true pentru ORICE POST,
// inclusiv pentru webhook-ul Stripe. Cum Stripe nu poate trimite header-ul
// X-Swypik-Internal-Secret, fiecare eveniment de plată primea 401 și se
// pierdea tăcut. Testele de mai jos fixează contractul: webhook-urile
// autentificate prin semnătură sunt exceptate, restul rămân protejate.

func newRequest(t *testing.T, method, path string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, "http://example.test"+path, nil)
	if err != nil {
		t.Fatalf("nu am putut construi cererea: %v", err)
	}
	return req
}

func TestStripeWebhookNuCereSecretIntern(t *testing.T) {
	req := newRequest(t, http.MethodPost, "/v1/payments/webhooks/stripe")
	if requiresInternalAuth(req) {
		t.Fatal("webhook-ul Stripe nu trebuie să ceară secretul intern: " +
			"Stripe nu îl poate trimite, iar autenticitatea se verifică prin semnătură HMAC")
	}
}

func TestPOSTObisnuitRamaneProtejat(t *testing.T) {
	for _, path := range []string{"/v1/events", "/v1/cart/items", "/v1/videos"} {
		if !requiresInternalAuth(newRequest(t, http.MethodPost, path)) {
			t.Fatalf("POST %s ar trebui să rămână protejat de secretul intern", path)
		}
	}
}

func TestRutaAdminRamaneProtejataChiarSiLaGET(t *testing.T) {
	if !requiresInternalAuth(newRequest(t, http.MethodGet, "/v1/admin/users")) {
		t.Fatal("rutele /v1/admin/ trebuie protejate indiferent de metoda HTTP")
	}
}

func TestExceptiaEsteExactaNuPrefix(t *testing.T) {
	// Allow-list strict: o cale care doar SEAMĂNĂ cu webhook-ul nu trebuie
	// să scape de autentificare (ex. tentativă de path traversal / sufix).
	suspecte := []string{
		"/v1/payments/webhooks/stripe/extra",
		"/v1/payments/webhooks/stripefake",
		"/v1/payments/webhooks",
	}
	for _, path := range suspecte {
		if !requiresInternalAuth(newRequest(t, http.MethodPost, path)) {
			t.Fatalf("calea %q nu e webhook-ul exact și trebuie să rămână protejată", path)
		}
	}
}
