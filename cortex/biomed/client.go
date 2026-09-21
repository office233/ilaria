package biomed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Fetcher performs one HTTP round-trip. *http.Client satisfies it; tests
// inject a fixture-backed implementation.
type Fetcher interface {
	Do(req *http.Request) (*http.Response, error)
}

// allowedHosts is the complete list of hosts this package will ever talk to.
// It is a security boundary (the organism may pass user text into queries),
// not a knowledge table.
var allowedHosts = map[string]bool{
	"rxnav.nlm.nih.gov":            true,
	"www.ebi.ac.uk":                true,
	"api.fda.gov":                  true,
	"api.platform.opentargets.org": true,
	"eutils.ncbi.nlm.nih.gov":      true,
}

const (
	defaultTTL       = 30 * 24 * time.Hour
	defaultThrottle  = 250 * time.Millisecond
	pubmedThrottle   = 350 * time.Millisecond // NCBI: max 3 req/s without an API key
	defaultBackoff   = 500 * time.Millisecond
	defaultTimeout   = 20 * time.Second
	maxAttempts      = 3
	defaultUserAgent = "NexusCortex-Ilaria-biomed/1.0 (+https://github.com/office233/Nexuscortex)"
)

// Client is the single gateway to the outside world: allow-list, per-host
// throttle, retries with backoff, and a disk cache that doubles as Ilaria's
// on-disk biomedical knowledge (it grows with every entity encountered).
type Client struct {
	fetcher   Fetcher
	cacheDir  string
	ttl       time.Duration
	throttle  time.Duration
	backoff   time.Duration
	userAgent string

	mu       sync.Mutex
	lastCall map[string]time.Time
}

// ClientOption customises NewClient.
type ClientOption func(*Client)

// WithFetcher replaces the HTTP transport (tests use recorded fixtures).
func WithFetcher(f Fetcher) ClientOption { return func(c *Client) { c.fetcher = f } }

// WithTTL sets how long a cached response stays valid.
func WithTTL(d time.Duration) ClientOption { return func(c *Client) { c.ttl = d } }

// WithThrottle sets the minimum spacing between requests to the same host
// (PubMed always gets at least its own floor unless throttle is 0).
func WithThrottle(d time.Duration) ClientOption { return func(c *Client) { c.throttle = d } }

// WithBackoff sets the base delay for retries after 429/503/network errors.
func WithBackoff(d time.Duration) ClientOption { return func(c *Client) { c.backoff = d } }

// WithUserAgent sets the User-Agent header.
func WithUserAgent(ua string) ClientOption { return func(c *Client) { c.userAgent = ua } }

// NewClient creates a client whose cache lives under cacheDir.
func NewClient(cacheDir string, opts ...ClientOption) *Client {
	c := &Client{
		fetcher:   &http.Client{Timeout: defaultTimeout},
		cacheDir:  cacheDir,
		ttl:       defaultTTL,
		throttle:  defaultThrottle,
		backoff:   defaultBackoff,
		userAgent: defaultUserAgent,
		lastCall:  map[string]time.Time{},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// CacheDir returns the directory holding cached responses.
func (c *Client) CacheDir() string { return c.cacheDir }

// GetJSON performs a GET and decodes the JSON body into out. cached reports
// whether the response came from disk.
func (c *Client) GetJSON(ctx context.Context, source, rawURL string, out any) (cached bool, err error) {
	return c.doJSON(ctx, source, http.MethodGet, rawURL, nil, out)
}

// PostJSON performs a POST with a JSON body and decodes the JSON response.
func (c *Client) PostJSON(ctx context.Context, source, rawURL string, body any, out any) (cached bool, err error) {
	b, err := json.Marshal(body)
	if err != nil {
		return false, fmt.Errorf("biomed/%s: encode body: %w", source, err)
	}
	return c.doJSON(ctx, source, http.MethodPost, rawURL, b, out)
}

type cacheEntry struct {
	Retrieved time.Time       `json:"retrieved"`
	URL       string          `json:"url"`
	Body      json.RawMessage `json:"body"`
}

func (c *Client) doJSON(ctx context.Context, source, method, rawURL string, body []byte, out any) (bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false, fmt.Errorf("biomed/%s: bad url: %w", source, err)
	}
	if u.Scheme != "https" || !allowedHosts[u.Hostname()] {
		return false, fmt.Errorf("biomed/%s: %s: %w", source, u.Hostname(), ErrDisallowedHost)
	}

	key := cacheKey(method, rawURL, body)
	path := filepath.Join(c.cacheDir, source, key+".json")

	if entry, ok := c.readCache(path); ok {
		if err := json.Unmarshal(entry.Body, out); err == nil {
			return true, nil
		}
		// corrupt cache entry: fall through and refetch
	}

	raw, fetchErr := c.fetchWithRetry(ctx, source, method, rawURL, body, u.Hostname())
	if fetchErr != nil {
		// Serve a stale copy rather than nothing when the network is down.
		if entry, ok := c.readCacheIgnoringTTL(path); ok {
			if err := json.Unmarshal(entry.Body, out); err == nil {
				return true, nil
			}
		}
		return false, fetchErr
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("biomed/%s: decode: %w", source, err)
	}
	c.writeCache(path, cacheEntry{Retrieved: time.Now().UTC(), URL: rawURL, Body: raw})
	return false, nil
}

func cacheKey(method, rawURL string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(rawURL))
	h.Write([]byte{'\n'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func (c *Client) readCache(path string) (cacheEntry, bool) {
	e, ok := c.readCacheIgnoringTTL(path)
	if !ok || time.Since(e.Retrieved) > c.ttl {
		return cacheEntry{}, false
	}
	return e, true
}

func (c *Client) readCacheIgnoringTTL(path string) (cacheEntry, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return cacheEntry{}, false
	}
	var e cacheEntry
	if err := json.Unmarshal(data, &e); err != nil || len(e.Body) == 0 {
		return cacheEntry{}, false
	}
	return e, true
}

func (c *Client) writeCache(path string, e cacheEntry) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// fetchWithRetry applies the per-host throttle, then tries up to maxAttempts
// times on 429/503/network errors with exponential backoff.
func (c *Client) fetchWithRetry(ctx context.Context, source, method, rawURL string, body []byte, host string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			delay := c.backoff * time.Duration(1<<uint(attempt-1))
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, fmt.Errorf("biomed/%s: %w", source, ctx.Err())
			}
		}
		if err := c.waitThrottle(ctx, host); err != nil {
			return nil, fmt.Errorf("biomed/%s: %w", source, err)
		}
		raw, status, err := c.fetchOnce(ctx, method, rawURL, body)
		switch {
		case err != nil:
			lastErr = fmt.Errorf("biomed/%s: %v: %w", source, err, ErrOffline)
			continue
		case status == http.StatusNotFound:
			return nil, fmt.Errorf("biomed/%s: %s: %w", source, rawURL, ErrNotFound)
		case status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable:
			lastErr = fmt.Errorf("biomed/%s: HTTP %d: %w", source, status, ErrOffline)
			continue
		case status >= 400:
			return nil, fmt.Errorf("biomed/%s: HTTP %d for %s", source, status, rawURL)
		}
		return raw, nil
	}
	return nil, lastErr
}

func (c *Client) fetchOnce(ctx context.Context, method, rawURL string, body []byte) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.fetcher.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return raw, resp.StatusCode, nil
}

func (c *Client) waitThrottle(ctx context.Context, host string) error {
	if c.throttle <= 0 {
		return nil
	}
	gap := c.throttle
	if strings.HasSuffix(host, "ncbi.nlm.nih.gov") && gap < pubmedThrottle {
		gap = pubmedThrottle
	}
	c.mu.Lock()
	wait := time.Until(c.lastCall[host].Add(gap))
	next := time.Now()
	if wait > 0 {
		next = next.Add(wait)
	}
	c.lastCall[host] = next
	c.mu.Unlock()
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
