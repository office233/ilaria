package search

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/charmap"
)

func mustOpen(t *testing.T, path string) *Engine {
	t.Helper()
	e, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return e
}

func urls(r *Result) []string {
	var out []string
	for _, s := range r.Sources {
		out = append(out, s.URL)
	}
	return out
}

func TestIndexPersistsAndRanksWithBM25F(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.jsonl")
	e := mustOpen(t, path)
	docs := []Document{
		{URL: "https://example.org/go", Title: "Go networking", Text: "Go connects using network sockets"},
		{URL: "https://example.org/garden", Title: "Garden", Text: "Flowers grow in a garden near networking cables"},
	}
	for _, d := range docs {
		if err := e.Upsert(d); err != nil {
			t.Fatal(err)
		}
	}
	e.Close()
	restored := mustOpen(t, path)
	r, err := restored.Search("networking")
	if err != nil || len(r.Sources) != 2 || r.Sources[0].URL != "https://example.org/go" {
		t.Fatalf("title match must rank first: %v %v", urls(r), err)
	}
	if err := restored.Delete("https://example.org/go"); err != nil {
		t.Fatal(err)
	}
	restored.Close()
	again := mustOpen(t, path)
	if r, _ := again.Search("networking"); len(r.Sources) != 1 {
		t.Fatalf("deletion not persisted: %v", urls(r))
	}
}

func TestAllTermsRankAboveSomeTerms(t *testing.T) {
	e := NewEngine()
	_ = e.Upsert(Document{URL: "https://a.org/1", Title: "one", Text: "linux kernel drivers"})
	_ = e.Upsert(Document{URL: "https://a.org/2", Title: "two", Text: "linux linux linux desktop"})
	r, _ := e.Search("linux drivers")
	if r.Sources[0].URL != "https://a.org/1" {
		t.Fatalf("coordination: %v", urls(r))
	}
}

func TestDiacriticsAndUnicodeFolding(t *testing.T) {
	e := NewEngine()
	_ = e.Upsert(Document{URL: "https://ro.org/", Title: "Știință", Text: "Institutul de știință din Győr și Cluj"})
	_ = e.Upsert(Document{URL: "https://ro.org/nfd", Title: "NFD", Text: "știință scrisă descompus"})
	for _, q := range []string{"stiinta", "ȘTIINȚĂ", "gyor", "Győr"} {
		r, _ := e.Search(q)
		if len(r.Sources) == 0 {
			t.Errorf("%q found nothing", q)
		}
	}
	if r, _ := e.Search("stiinta"); len(r.Sources) != 2 {
		t.Fatalf("decomposed text must match: %v", urls(r))
	}
}

func TestPrefixAndSnippet(t *testing.T) {
	e := NewEngine()
	text := strings.Repeat("filler ", 60) + "the scheduler balances goroutines across threads" + strings.Repeat(" tail", 60)
	_ = e.Upsert(Document{URL: "https://go.dev/sched", Title: "Runtime", Text: text})
	r, _ := e.Search("goroutin")
	if len(r.Sources) != 1 {
		t.Fatal("prefix of the last term should match")
	}
	if !strings.Contains(r.Sources[0].Snippet, "goroutines") || !strings.HasPrefix(r.Sources[0].Snippet, "…") {
		t.Fatalf("snippet not centred on match: %q", r.Sources[0].Snippet)
	}
}

func TestNoopWritesAreSkipped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.jsonl")
	e := mustOpen(t, path)
	d := Document{URL: "https://a.org/", Title: "A", Text: "alpha", SHA256: "abc"}
	_ = e.Upsert(d)
	size := func() int64 { fi, _ := os.Stat(path); return fi.Size() }
	before := size()
	if n, err := e.UpsertMany([]Document{d}); err != nil || n != 0 {
		t.Fatalf("unchanged document rewritten: %d %v", n, err)
	}
	if err := e.Delete("https://a.org/absent"); err != nil {
		t.Fatal(err)
	}
	if size() != before {
		t.Fatal("no-op operations must not write")
	}
}

func TestTornTailIsRepaired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.jsonl")
	e := mustOpen(t, path)
	_ = e.Upsert(Document{URL: "https://a.org/", Title: "A", Text: "alpha"})
	e.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString(`{"op":"put","doc":{"url":"https://a.org/b","ti`)
	f.Close()
	e = mustOpen(t, path)
	if e.Count() != 1 || len(e.Warnings()) != 1 {
		t.Fatalf("count=%d warnings=%v", e.Count(), e.Warnings())
	}
	if err := e.Upsert(Document{URL: "https://a.org/c", Title: "C", Text: "gamma"}); err != nil {
		t.Fatal(err)
	}
	e.Close()
	if e = mustOpen(t, path); e.Count() != 2 || len(e.Warnings()) != 0 {
		t.Fatalf("after repair: count=%d warnings=%v", e.Count(), e.Warnings())
	}
}

func TestCorruptIndexIsQuarantinedNotFatal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.jsonl")
	e := mustOpen(t, path)
	_ = e.Upsert(Document{URL: "https://a.org/", Title: "A", Text: "alpha"})
	e.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("garbage line\n")
	f.WriteString(`{"op":"put","doc":{"url":"https://a.org/z","title":"Z","text":"zeta","fetched_at":"0001-01-01T00:00:00Z","sha256":""}}` + "\n")
	f.Close()
	e = mustOpen(t, path)
	if e.Count() != 1 || len(e.Warnings()) != 1 {
		t.Fatalf("count=%d warnings=%v", e.Count(), e.Warnings())
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "index.jsonl.corrupt-*"))
	if len(matches) != 1 {
		t.Fatal("damaged original must be preserved for inspection")
	}
}

func TestImportLegacyJSON(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "search-index.json")
	raw, _ := json.Marshal(map[string]interface{}{"version": 1, "documents": []Document{{URL: "https://Example.org:443/x", Title: "Old", Text: "legacy text"}}})
	os.WriteFile(legacy, raw, 0600)
	e := mustOpen(t, filepath.Join(dir, "index.jsonl"))
	n, err := e.ImportLegacy(legacy)
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if r, _ := e.Search("legacy"); len(r.Sources) != 1 || r.Sources[0].URL != "https://example.org/x" {
		t.Fatalf("%v", urls(r))
	}
	if _, err := os.Stat(legacy + ".migrated"); err != nil {
		t.Fatal("legacy file must be kept, renamed")
	}
}

func TestExtractToleratesRealWorldHTML(t *testing.T) {
	base, _ := url.Parse("https://site.org/dir/page")
	messy := `<html><head><title>Messy &amp; real</title><base href=/root/>
<script>var a = "<p>hidden</p>";</script><style>p{}</style>
<body><img src=a.png><p>a < b && c</p><a href=x?a=1&b=2>link</a>
<noscript>noscript text</noscript><div>visible<span>text</span></div>
<a href="/n" rel="nofollow">skip</a><meta name=robots content="NOINDEX, follow">`
	p := extract(strings.NewReader(messy), base)
	if p.Title != "Messy & real" || !p.NoIndex || p.NoFollow {
		t.Fatalf("%+v", p)
	}
	for _, bad := range []string{"hidden", "noscript text", "p{}"} {
		if strings.Contains(p.Text, bad) {
			t.Fatalf("indexed %q: %q", bad, p.Text)
		}
	}
	if !strings.Contains(p.Text, "a < b && c") || !strings.Contains(p.Text, "visible") {
		t.Fatalf("text %q", p.Text)
	}
	if len(p.Links) != 1 || p.Links[0] != "https://site.org/root/x?a=1&b=2" {
		t.Fatalf("links %v (base href must apply, nofollow skipped)", p.Links)
	}
	// </head> is optional: body text after an unclosed head is still indexed.
	p = extract(strings.NewReader(`<head><title>T</title><body>body words`), base)
	if p.Text != "body words" {
		t.Fatalf("unclosed head swallowed body: %q", p.Text)
	}
}

func TestCanonicalURLs(t *testing.T) {
	for in, want := range map[string]string{
		"HTTPS://Example.ORG:443/a#frag": "https://example.org/a",
		"http://example.org:80":          "http://example.org/",
	} {
		if got, err := canonical(in); err != nil || got != want {
			t.Errorf("%s -> %s %v", in, got, err)
		}
	}
	for _, bad := range []string{"ftp://x.org/", "https://user@x.org/", "https://x.org:8080/", "/relative"} {
		if _, err := canonical(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestPrivateAddressDenied(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "2001:db8::1", "::7f00:1", "fec0::1", "64:ff9b:1::1"} {
		if publicAddress(netip.MustParseAddr(s)) {
			t.Error(s)
		}
	}
	if !publicAddress(netip.MustParseAddr("93.184.216.34")) {
		t.Fatal("public IP rejected")
	}
}

func TestRobotsRules(t *testing.T) {
	p := parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*?token=*\n")
	if p.allowed("/private/a") || !p.allowed("/private/public/a") || p.allowed("/x?token=secret") {
		t.Fatal("longest match")
	}
	p = parseRobots("User-agent: *\nDisallow: /\nUser-agent: SwypikBot\nDisallow: /secrets\n")
	if !p.allowed("/docs") || p.allowed("/secrets") {
		t.Fatal("specific group not selected")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// siteClient routes every host to one test server and records the Host asked for.
func siteClient(t *testing.T, handler http.HandlerFunc) *http.Client {
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	inner := srv.Client().Transport
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			req = req.Clone(req.Context())
			req.Header.Set("X-Test-Origin", req.URL.Scheme+"://"+req.URL.Host)
			req.URL.Scheme, req.URL.Host = "http", strings.TrimPrefix(srv.URL, "http://")
			return inner.RoundTrip(req)
		}),
	}
}

func TestCrawlerOwnCorpus(t *testing.T) {
	hits := map[string]int{}
	client := siteClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits[r.URL.Path]++
		if r.UserAgent() != UserAgent {
			t.Error("missing user agent")
		}
		if r.URL.Path == "/robots.txt" {
			w.Write([]byte("User-agent: *\nDisallow: /private"))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/":
			w.Write([]byte(`<title>Native systems</title><body>Swypik Linux networking<a href="/second">s</a><a href="/private">p</a><a href="/noindex">n</a><a href="https://other.org/">o</a>`))
		case "/second":
			w.Write([]byte(`<title>Drivers</title><p>Linux networking drivers</p>`))
		case "/noindex":
			w.Write([]byte(`<meta name="robots" content="noindex"><p>Never index this word excluded</p>`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})
	e := NewEngine()
	report, err := e.crawl(context.Background(), "https://example.org/", 8, client, 0)
	if err != nil || report.Indexed != 2 || hits["/private"] != 0 {
		t.Fatalf("%+v %v hits=%v", report, err, hits)
	}
	if r, _ := e.Search("networking"); len(r.Sources) != 2 {
		t.Fatalf("%v", urls(r))
	}
	if r, _ := e.Search("excluded"); len(r.Sources) != 0 {
		t.Fatal("noindex ignored")
	}
}

func TestCrawlerFollowsPreferredOriginAndDecodesCharset(t *testing.T) {
	client := siteClient(t, func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("X-Test-Origin")
		if origin == "http://example.org" {
			http.Redirect(w, r, "https://www.example.org"+r.URL.Path, http.StatusMovedPermanently)
			return
		}
		if r.URL.Path == "/robots.txt" {
			http.NotFound(w, r)
			return
		}
		// Legacy Romanian pages use the cedilla letters that windows-1250 has.
		body, err := charmap.Windows1250.NewEncoder().String("<title>Pagină</title><p>Ştiinţă şi tehnică</p>")
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/html; charset=windows-1250")
		w.Write([]byte(body))
	})
	e := NewEngine()
	report, err := e.crawl(context.Background(), "http://example.org/", 2, client, 0)
	if err != nil || report.Origin != "https://www.example.org" || report.Indexed != 1 {
		t.Fatalf("%+v %v", report, err)
	}
	r, _ := e.Search("stiinta")
	if len(r.Sources) != 1 || r.Sources[0].Title != "Pagină" {
		t.Fatalf("windows-1250 not decoded: %+v", r.Sources)
	}
}

func TestCrawlerStopsOnRobotsFailureOrOffSiteRedirect(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"503": func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) },
		"off-site": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://evil.example/robots.txt", 302)
		},
	} {
		e := NewEngine()
		if _, err := e.crawl(context.Background(), "https://example.org/", 1, siteClient(t, handler), 0); err == nil {
			t.Errorf("%s: crawl must stop", name)
		}
	}
}

func TestIndexDirectory(t *testing.T) {
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(p), 0700)
		os.WriteFile(p, []byte(content), 0600)
	}
	write("notes/plan.md", "# Plan\nIlaria orchestrează agenții locali")
	write("src/main.go", "package main // scheduler entrypoint")
	write("node_modules/lib/x.js", "scheduler vendored")
	write(".git/config", "scheduler hidden")
	write("image.png", "scheduler binary ext")
	write("blob.txt", "text\x00with nul scheduler")
	e := mustOpen(t, filepath.Join(t.TempDir(), "i.jsonl"))
	rep, err := e.IndexDirectory(context.Background(), root, 0)
	if err != nil || rep.Indexed != 2 {
		t.Fatalf("%+v %v", rep, err)
	}
	if r, _ := e.Search("scheduler"); len(r.Sources) != 1 || !strings.HasSuffix(r.Sources[0].URL, "/src/main.go") {
		t.Fatalf("%v", urls(r))
	}
	if r, _ := e.Search("orchestreaza"); len(r.Sources) != 1 {
		t.Fatal("diacritics in local files")
	}
	if p, ok := FilePath(FileURL(filepath.Join(root, "notes", "plan.md"))); !ok || p != filepath.Join(root, "notes", "plan.md") {
		t.Fatalf("file URL round trip: %s", p)
	}
	// Re-index: unchanged files are not rewritten; deleted files are removed.
	os.Remove(filepath.Join(root, "src", "main.go"))
	rep, err = e.IndexDirectory(context.Background(), root, 0)
	if err != nil || rep.Indexed != 0 || rep.Removed != 1 || e.Count() != 1 {
		t.Fatalf("%+v %v count=%d", rep, err, e.Count())
	}
}

func TestSearchJSONHasNoFabricatedFields(t *testing.T) {
	e := NewEngine()
	r, _ := e.Search("anything")
	raw, _ := json.Marshal(r)
	for _, bad := range []string{"ai_answer", "trackers", "ads"} {
		if bytes.Contains(raw, []byte(bad)) {
			t.Fatalf("fabricated field %s in %s", bad, raw)
		}
	}
}
