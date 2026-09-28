package search

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html/charset"
)

const UserAgent = "SwypikBot/0.2 (+own index; respects robots.txt)"

const (
	MaxCrawlPages  = 64
	maxQueue       = 512
	maxPageBytes   = 2 << 20
	maxRobotsBytes = 512 << 10
)

type CrawlReport struct {
	Origin  string   `json:"origin"`
	Fetched int      `json:"fetched"`
	Indexed int      `json:"indexed"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors"`
}

// canonical returns the normalized form of an absolute HTTP(S) URL: lower-case
// scheme and host, default port removed, fragment dropped, empty path as "/".
func canonical(raw string) (string, error) {
	if len(raw) > 2048 {
		return "", fmt.Errorf("URL too long")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || u.User != nil || strings.Contains(u.Hostname(), "%") {
		return "", fmt.Errorf("absolute HTTP(S) URL required")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("absolute HTTP(S) URL required")
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" && port != "80" && port != "443" {
		return "", fmt.Errorf("only standard web ports are allowed")
	}
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	if port != "" {
		u.Host += ":" + port
	}
	u.Fragment, u.RawFragment = "", ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}

func originOf(canonicalURL string) string {
	u, _ := url.Parse(canonicalURL)
	return u.Scheme + "://" + u.Host
}

// sameSite accepts the redirects sites use to pick their preferred origin:
// http -> https and example.org <-> www.example.org.
func sameSite(a, b string) bool {
	ua, _ := url.Parse(a)
	ub, _ := url.Parse(b)
	if ua == nil || ub == nil {
		return false
	}
	return strings.TrimPrefix(ua.Hostname(), "www.") == strings.TrimPrefix(ub.Hostname(), "www.")
}

var blocked = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"::/96", "fec0::/10", "2001:db8::/32", "2001::/32", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48"} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// publicAddress rejects loopback, private, link-local (including cloud
// metadata endpoints), carrier-grade NAT, documentation and translation ranges.
func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range blocked {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// safeDial resolves once, rejects the request if ANY address is non-public and
// connects to the verified address, which prevents DNS rebinding.
func safeDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("DNS returned no addresses")
	}
	for _, ip := range ips {
		if !publicAddress(ip) {
			return nil, fmt.Errorf("non-public destination blocked")
		}
	}
	var last error
	for _, ip := range ips {
		conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}

// Crawl indexes up to limit pages of one site, starting at seed. The caller
// must have the user's consent to contact that site.
func (e *Engine) Crawl(ctx context.Context, seed string, limit int) (CrawlReport, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = safeDial
	transport.MaxConnsPerHost = 1
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return e.crawl(ctx, seed, limit, client, time.Second)
}

type fetched struct {
	body     []byte
	status   int
	header   http.Header
	location string
}

// crawl is sequential and polite: one request per delay, same-site only, no
// cookies, forms, scripts or credentials, and never a background crawl.
func (e *Engine) crawl(ctx context.Context, seed string, limit int, client *http.Client, delay time.Duration) (CrawlReport, error) {
	report := CrawlReport{Errors: []string{}}
	if limit < 1 || limit > MaxCrawlPages {
		return report, fmt.Errorf("page limit must be 1-%d", MaxCrawlPages)
	}
	seed, err := canonical(seed)
	if err != nil {
		return report, err
	}
	if !e.crawlMu.TryLock() {
		return report, fmt.Errorf("a crawl is already running")
	}
	defer e.crawlMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	first := true
	fetch := func(raw string, max int) (fetched, error) {
		if !first {
			select {
			case <-ctx.Done():
				return fetched{}, ctx.Err()
			case <-time.After(delay):
			}
		}
		first = false
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			return fetched{}, err
		}
		req.Header.Set("User-Agent", UserAgent)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.8")
		res, err := client.Do(req)
		if err != nil {
			return fetched{}, err
		}
		defer res.Body.Close()
		b, err := io.ReadAll(io.LimitReader(res.Body, int64(max)+1))
		if err != nil {
			return fetched{}, err
		}
		if len(b) > max {
			return fetched{}, fmt.Errorf("response exceeds %d bytes", max)
		}
		f := fetched{body: b, status: res.StatusCode, header: res.Header}
		if loc := res.Header.Get("Location"); loc != "" {
			// Resolve against the URL we asked for, not a transport-rewritten one.
			if base, err := url.Parse(raw); err == nil {
				if next, err := base.Parse(loc); err == nil {
					f.location = next.String()
				}
			}
		}
		return f, nil
	}

	// robots.txt decides the crawl origin. A redirect to the site's preferred
	// origin (https, www) is followed at most twice; anything else stops the
	// crawl rather than bypassing site controls. Only 404/410 mean "no rules".
	origin := originOf(seed)
	var robotsRes fetched
	for hop := 0; ; hop++ {
		robotsRes, err = fetch(origin+"/robots.txt", maxRobotsBytes)
		if err != nil {
			return report, fmt.Errorf("robots.txt unavailable: %w", err)
		}
		if robotsRes.status < 300 || robotsRes.status >= 400 || hop == 2 {
			break
		}
		next, cerr := canonical(robotsRes.location)
		if cerr != nil || !sameSite(origin, next) || !strings.HasSuffix(next, "/robots.txt") {
			return report, fmt.Errorf("robots.txt redirected off-site: crawl stopped")
		}
		newOrigin := originOf(next)
		seedURL, _ := url.Parse(seed)
		seed = newOrigin + seedURL.RequestURI()
		origin = newOrigin
	}
	policy := robots{}
	switch robotsRes.status {
	case http.StatusOK:
		policy = parseRobots(string(robotsRes.body))
	case http.StatusNotFound, http.StatusGone:
	default:
		return report, fmt.Errorf("robots.txt HTTP %d: crawl stopped", robotsRes.status)
	}
	report.Origin = origin

	queue := []string{seed}
	visited := map[string]bool{}
	for len(queue) > 0 && report.Fetched < limit {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		raw := queue[0]
		queue = queue[1:]
		if visited[raw] {
			continue
		}
		visited[raw] = true
		pageURL, _ := url.Parse(raw)
		if !policy.allowed(pageURL.RequestURI()) {
			report.Skipped++
			if err := e.Delete(raw); err != nil {
				return report, err
			}
			continue
		}
		res, err := fetch(raw, maxPageBytes)
		report.Fetched++
		if err != nil {
			report.Errors = append(report.Errors, raw+": "+err.Error())
			continue
		}
		if res.status >= 300 && res.status < 400 {
			if next, cerr := canonical(res.location); cerr == nil && originOf(next) == origin && !visited[next] {
				queue = append([]string{next}, queue...)
			}
			report.Skipped++
			continue
		}
		if res.status != http.StatusOK {
			report.Skipped++
			if res.status == http.StatusNotFound || res.status == http.StatusGone {
				if err := e.Delete(raw); err != nil {
					return report, err
				}
			}
			continue
		}
		if len(bytes.TrimSpace(res.body)) == 0 {
			report.Skipped++
			continue
		}
		mediaType, _, _ := mime.ParseMediaType(res.header.Get("Content-Type"))
		var p page
		switch mediaType {
		case "text/html", "application/xhtml+xml":
			// charset.NewReader honours the header, BOM and <meta charset>, so
			// windows-1250 and ISO-8859-2 pages are indexed correctly.
			r, cerr := charset.NewReader(bytes.NewReader(res.body), res.header.Get("Content-Type"))
			if cerr != nil {
				report.Errors = append(report.Errors, raw+": unsupported charset")
				continue
			}
			p = extract(r, pageURL)
		case "text/plain":
			r, cerr := charset.NewReader(bytes.NewReader(res.body), res.header.Get("Content-Type"))
			if cerr != nil {
				report.Errors = append(report.Errors, raw+": unsupported charset")
				continue
			}
			b, _ := io.ReadAll(r)
			p.Text = clip(strings.Join(strings.Fields(string(b)), " "), MaxTextBytes)
		default:
			report.Skipped++
			continue
		}
		ni, nf := robotsDirectives(res.header.Get("X-Robots-Tag"))
		p.NoIndex, p.NoFollow = p.NoIndex || ni, p.NoFollow || nf
		if p.NoIndex || strings.TrimSpace(p.Text) == "" {
			report.Skipped++
			if err := e.Delete(raw); err != nil {
				return report, err
			}
		} else {
			if p.Title == "" {
				p.Title = pageURL.Hostname() + pageURL.EscapedPath()
			}
			digest := sha256.Sum256(res.body)
			if err := e.Upsert(Document{URL: raw, Title: clip(p.Title, 512), Text: p.Text, FetchedAt: time.Now().UTC(), SHA256: hex.EncodeToString(digest[:])}); err != nil {
				return report, err
			}
			report.Indexed++
		}
		if p.NoFollow {
			continue
		}
		for _, link := range p.Links {
			next, cerr := canonical(link)
			if cerr != nil || originOf(next) != origin || visited[next] || len(queue) >= maxQueue {
				continue
			}
			queue = append(queue, next)
		}
	}
	return report, ctx.Err()
}

type rule struct {
	path  string
	allow bool
}

type robots struct{ rules []rule }

// parseRobots implements RFC 9309 group selection: the group naming
// SwypikBot wins over "*"; rules are matched by longest path.
func parseRobots(raw string) robots {
	type group struct {
		agents []string
		rules  []rule
	}
	var groups []group
	var g group
	flush := func() {
		if len(g.agents) > 0 {
			groups = append(groups, g)
		}
		g = group{}
	}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		pair := strings.SplitN(line, ":", 2)
		if len(pair) != 2 {
			continue
		}
		k, v := strings.ToLower(strings.TrimSpace(pair[0])), strings.TrimSpace(pair[1])
		switch k {
		case "user-agent":
			if len(g.rules) > 0 {
				flush()
			}
			g.agents = append(g.agents, strings.ToLower(v))
		case "allow", "disallow":
			if len(g.agents) > 0 && v != "" {
				g.rules = append(g.rules, rule{v, k == "allow"})
			}
		}
	}
	flush()
	best := 0
	var result robots
	for _, g := range groups {
		specificity := 0
		for _, a := range g.agents {
			if a == "*" && specificity < 1 {
				specificity = 1
			}
			if a == "swypikbot" {
				specificity = 10
			}
		}
		if specificity == 0 || specificity < best {
			continue
		}
		if specificity > best {
			best = specificity
			result.rules = nil
		}
		result.rules = append(result.rules, g.rules...)
	}
	return result
}

func (r robots) allowed(path string) bool {
	allowed, best := true, -1
	for _, rule := range r.rules {
		pattern := strings.ReplaceAll(regexp.QuoteMeta(rule.path), `\*`, ".*")
		if strings.HasSuffix(pattern, `\$`) {
			pattern = strings.TrimSuffix(pattern, `\$`) + "$"
		}
		if ok, _ := regexp.MatchString("^"+pattern, path); !ok {
			continue
		}
		n := len(strings.ReplaceAll(strings.TrimSuffix(rule.path, "$"), "*", ""))
		if n > best || (n == best && rule.allow) {
			best, allowed = n, rule.allow
		}
	}
	return allowed
}
