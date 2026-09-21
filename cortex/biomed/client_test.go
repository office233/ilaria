package biomed

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fixtureFetcher serves recorded API responses from testdata by URL substring.
// Routes map a substring of the request URL (plus optional "POST:" prefix and
// body substring, e.g. "POST:opentargets|MONDO_0005233") to a testdata path.
// Unknown URLs return a 404 and are counted so tests can assert on traffic.
type fixtureFetcher struct {
	t      *testing.T
	routes map[string]string
	mu     sync.Mutex
	calls  []string
	status map[string][]int // optional scripted status codes per route key
}

func newFixtureFetcher(t *testing.T, routes map[string]string) *fixtureFetcher {
	t.Helper()
	return &fixtureFetcher{t: t, routes: routes, status: map[string][]int{}}
}

func (f *fixtureFetcher) Do(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body := ""
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		body = string(b)
	}
	f.calls = append(f.calls, req.Method+" "+req.URL.String())
	for key, path := range f.routes {
		urlPart, bodyPart := key, ""
		if strings.HasPrefix(key, "POST:") {
			parts := strings.SplitN(strings.TrimPrefix(key, "POST:"), "|", 2)
			urlPart = parts[0]
			if len(parts) == 2 {
				bodyPart = parts[1]
			}
		}
		if !strings.Contains(req.URL.String(), urlPart) || (bodyPart != "" && !strings.Contains(body, bodyPart)) {
			continue
		}
		code := http.StatusOK
		if scripted := f.status[key]; len(scripted) > 0 {
			code, f.status[key] = scripted[0], scripted[1:]
		}
		if code != http.StatusOK {
			return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
		}
		if path == "" { // empty path = network failure
			return nil, errors.New("dial tcp: no route to host")
		}
		data, err := os.ReadFile(filepath.Join("testdata", path))
		if err != nil {
			f.t.Fatalf("fixture %s: %v", path, err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: http.Header{"Content-Type": {"application/json"}}}, nil
	}
	return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{"error":"not found"}`)), Header: http.Header{}}, nil
}

func (f *fixtureFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func TestClient_RejectsDisallowedHostBeforeFetching(t *testing.T) {
	ff := newFixtureFetcher(t, nil)
	c := NewClient(t.TempDir(), WithFetcher(ff))
	var out map[string]any
	_, err := c.GetJSON(context.Background(), "evil", "https://example.com/x.json", &out)
	if !errors.Is(err, ErrDisallowedHost) {
		t.Fatalf("err = %v, want ErrDisallowedHost", err)
	}
	if ff.callCount() != 0 {
		t.Fatalf("fetcher was called %d times, want 0", ff.callCount())
	}
}

func TestClient_SecondGetServedFromDiskCache(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"rxcui/328134/properties": "rxnorm/props_328134.json"})
	dir := t.TempDir()
	c := NewClient(dir, WithFetcher(ff), WithThrottle(0))
	url := "https://rxnav.nlm.nih.gov/REST/rxcui/328134/properties.json"
	var out1, out2 map[string]any
	cached, err := c.GetJSON(context.Background(), "rxnorm", url, &out1)
	if err != nil || cached {
		t.Fatalf("first get: cached=%v err=%v", cached, err)
	}
	// A fresh client over the same directory must hit the disk cache, not the network.
	c2 := NewClient(dir, WithFetcher(ff), WithThrottle(0))
	cached, err = c2.GetJSON(context.Background(), "rxnorm", url, &out2)
	if err != nil || !cached {
		t.Fatalf("second get: cached=%v err=%v", cached, err)
	}
	if ff.callCount() != 1 {
		t.Fatalf("fetcher calls = %d, want 1", ff.callCount())
	}
	if out2["properties"].(map[string]any)["name"] != "gefitinib" {
		t.Fatalf("cached payload mismatch: %v", out2)
	}
	entries, _ := filepath.Glob(filepath.Join(dir, "rxnorm", "*.json"))
	if len(entries) != 1 {
		t.Fatalf("cache files = %v, want exactly one under <dir>/rxnorm/", entries)
	}
}

func TestClient_ExpiredTTLRefetches(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"rxcui/328134/properties": "rxnorm/props_328134.json"})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0), WithTTL(time.Nanosecond))
	url := "https://rxnav.nlm.nih.gov/REST/rxcui/328134/properties.json"
	var out map[string]any
	if _, err := c.GetJSON(context.Background(), "rxnorm", url, &out); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	cached, err := c.GetJSON(context.Background(), "rxnorm", url, &out)
	if err != nil || cached {
		t.Fatalf("expired entry must refetch: cached=%v err=%v", cached, err)
	}
	if ff.callCount() != 2 {
		t.Fatalf("fetcher calls = %d, want 2", ff.callCount())
	}
}

func TestClient_RetriesOn503ThenSucceeds(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"rxcui/328134/properties": "rxnorm/props_328134.json"})
	ff.status["rxcui/328134/properties"] = []int{503, 503}
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0), WithBackoff(time.Millisecond))
	var out map[string]any
	if _, err := c.GetJSON(context.Background(), "rxnorm", "https://rxnav.nlm.nih.gov/REST/rxcui/328134/properties.json", &out); err != nil {
		t.Fatalf("expected success after two 503s, got %v", err)
	}
	if ff.callCount() != 3 {
		t.Fatalf("fetcher calls = %d, want 3", ff.callCount())
	}
}

func TestClient_GivesUpAfterThreeAttempts(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"rxcui/328134/properties": "rxnorm/props_328134.json"})
	ff.status["rxcui/328134/properties"] = []int{503, 503, 503, 503}
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0), WithBackoff(time.Millisecond))
	var out map[string]any
	_, err := c.GetJSON(context.Background(), "rxnorm", "https://rxnav.nlm.nih.gov/REST/rxcui/328134/properties.json", &out)
	if err == nil {
		t.Fatal("expected error after 3 failed attempts")
	}
	if ff.callCount() != 3 {
		t.Fatalf("fetcher calls = %d, want 3", ff.callCount())
	}
}

func TestClient_NetworkFailureWithoutCacheIsErrOffline(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{"rxcui/328134/properties": ""}) // "" = network failure
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0), WithBackoff(time.Millisecond))
	var out map[string]any
	_, err := c.GetJSON(context.Background(), "rxnorm", "https://rxnav.nlm.nih.gov/REST/rxcui/328134/properties.json", &out)
	if !errors.Is(err, ErrOffline) {
		t.Fatalf("err = %v, want ErrOffline", err)
	}
	if !strings.Contains(err.Error(), "rxnorm") {
		t.Fatalf("error must name the source: %v", err)
	}
}

func TestClient_404IsErrNotFound(t *testing.T) {
	ff := newFixtureFetcher(t, nil)
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	var out map[string]any
	_, err := c.GetJSON(context.Background(), "openfda", "https://api.fda.gov/drug/label.json?search=nothing", &out)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestClient_PostJSONCachesByBody(t *testing.T) {
	ff := newFixtureFetcher(t, map[string]string{
		"POST:opentargets|disease": "opentargets/search_disease.json",
		"POST:opentargets|target":  "opentargets/target_EGFR.json",
	})
	c := NewClient(t.TempDir(), WithFetcher(ff), WithThrottle(0))
	url := "https://api.platform.opentargets.org/api/v4/graphql"
	var a, b, a2 map[string]any
	if _, err := c.PostJSON(context.Background(), "opentargets", url, map[string]string{"query": "{ disease }"}, &a); err != nil {
		t.Fatal(err)
	}
	if _, err := c.PostJSON(context.Background(), "opentargets", url, map[string]string{"query": "{ target }"}, &b); err != nil {
		t.Fatal(err)
	}
	cached, err := c.PostJSON(context.Background(), "opentargets", url, map[string]string{"query": "{ disease }"}, &a2)
	if err != nil || !cached {
		t.Fatalf("third post (same body) must be cached: cached=%v err=%v", cached, err)
	}
	if ff.callCount() != 2 {
		t.Fatalf("fetcher calls = %d, want 2 (different bodies)", ff.callCount())
	}
}
