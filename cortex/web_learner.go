package cortex

// web_learner.go — Autonomous web knowledge acquisition for Ilaria.
//
// Uses free, no-API-key-required sources:
//   - Wikipedia REST API (summary + full text)
//   - Wiktionary (word definitions)
//
// The WebLearner searches for information, extracts clean text,
// and feeds it through the Organism's learning pipeline.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// defaultAllowedDomains is the single source of truth for the default SSRF
// domain allowlist. Referenced by NewWebLearnerFromConfig, isAllowedURL, and
// IsAllowedURL to avoid maintenance drift across three call sites.
var defaultAllowedDomains = []string{"huggingface.co", "datasets-server.huggingface.co", "wikipedia.org"}

// WebLearner searches the web and converts discoveries into training data.
type WebLearner struct {
	Client    *http.Client
	RateLimit time.Duration // minimum pause between requests
	lastReq   time.Time

	// Configurable endpoints and limits (from Config)
	BodyLimit      int64    // max HTTP response body in bytes
	UserAgent      string   // User-Agent header
	WikiBaseURL    string   // e.g. "wikipedia.org"
	HFSearchURL    string   // HuggingFace dataset search URL
	HFRowsURL      string   // HuggingFace rows API URL
	AllowedDomains []string // Allowed domains for SSRF URL check

	// Stats
	TotalSearches int
	TotalLearned  int
	TotalFacts    int
}

// NewWebLearner creates a web learner from Config values.
func NewWebLearner() *WebLearner {
	return NewWebLearnerFromConfig(DefaultConfig())
}

// NewWebLearnerFromConfig creates a web learner with all values from Config.
func NewWebLearnerFromConfig(cfg Config) *WebLearner {
	timeout := time.Duration(cfg.WebLearnerTimeoutSecs) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	rateLimit := time.Duration(cfg.WebLearnerRateLimitMs) * time.Millisecond
	if rateLimit <= 0 {
		rateLimit = 2 * time.Second
	}
	// Toate fallback-urile de mai jos folosesc DefaultConfig() ca sursă unică
	// de adevăr. Înainte erau string-literal duplicate care puteau drift-ui
	// față de cortex/config.go (vezi raport audit, problemele 5.6-5.8).
	defaults := DefaultConfig()
	bodyLimitMB := cfg.WebLearnerBodyLimitMB
	if bodyLimitMB <= 0 {
		bodyLimitMB = defaults.WebLearnerBodyLimitMB
	}
	userAgent := cfg.WebLearnerUserAgent
	if userAgent == "" {
		userAgent = defaults.WebLearnerUserAgent
	}
	wikiBase := cfg.WebLearnerWikiBaseURL
	if wikiBase == "" {
		wikiBase = defaults.WebLearnerWikiBaseURL
	}
	hfSearch := cfg.WebLearnerHFSearchURL
	if hfSearch == "" {
		hfSearch = defaults.WebLearnerHFSearchURL
	}
	hfRows := cfg.WebLearnerHFRowsURL
	if hfRows == "" {
		hfRows = defaults.WebLearnerHFRowsURL
	}

	allowedDomains := cfg.WebLearnerAllowedDomains
	if len(allowedDomains) == 0 {
		allowedDomains = defaultAllowedDomains
	}

	wl := &WebLearner{
		RateLimit:      rateLimit,
		BodyLimit:      int64(bodyLimitMB) << 20,
		UserAgent:      userAgent,
		WikiBaseURL:    wikiBase,
		HFSearchURL:    hfSearch,
		HFRowsURL:      hfRows,
		AllowedDomains: allowedDomains,
	}

	wl.Client = &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("SSRF prevention: too many redirects (%d)", len(via))
			}
			if !wl.IsAllowedURL(req.URL.String()) {
				return fmt.Errorf("SSRF prevention: blocked redirect to %s", req.URL.String())
			}
			return nil
		},
	}

	return wl
}

// SearchResult holds one piece of discovered knowledge.
type SearchResult struct {
	Title   string
	Snippet string // Short summary
	Content string // Full clean text
	URL     string
	Source  string // "wikipedia", "wiktionary"
}

// throttle ensures we respect rate limits.
func (wl *WebLearner) throttle() {
	elapsed := time.Since(wl.lastReq)
	if elapsed < wl.RateLimit {
		time.Sleep(wl.RateLimit - elapsed)
	}
	wl.lastReq = time.Now()
}

// isAllowedURL is the package-level compatibility wrapper (uses default allowlist).
func isAllowedURL(targetURL string) bool {
	return checkAllowedURL(targetURL, defaultAllowedDomains)
}

// IsAllowedURL checks if a URL is in the WebLearner's configured allowlist.
func (wl *WebLearner) IsAllowedURL(targetURL string) bool {
	domains := wl.AllowedDomains
	if len(domains) == 0 {
		domains = defaultAllowedDomains
	}
	return checkAllowedURL(targetURL, domains)
}

// Do is a defense-in-depth wrapper around wl.Client.Do that validates the
// request URL against the allowlist BEFORE issuing the request. This ensures
// SSRF protection on initial requests, not just redirects.
func (wl *WebLearner) Do(req *http.Request) (*http.Response, error) {
	if !wl.IsAllowedURL(req.URL.String()) {
		return nil, fmt.Errorf("SSRF prevention: blocked request to %s", req.URL.String())
	}
	return wl.Client.Do(req)
}

// checkAllowedURL checks if a URL's host is in the given domain allowlist.
func checkAllowedURL(targetURL string, allowed []string) bool {
	u, err := url.Parse(targetURL)
	if err != nil {
		return false
	}
	if u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}

	for _, domain := range allowed {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

// SearchWikipedia searches Wikipedia for articles matching the query.
// Returns up to maxResults results with summaries.
func (wl *WebLearner) SearchWikipedia(query string, lang string, maxResults int) ([]SearchResult, error) {
	wl.throttle()
	wl.TotalSearches++

	if lang == "" {
		lang = "en"
	}
	if maxResults <= 0 {
		maxResults = 5
	}

	// Wikipedia search API
	apiURL := fmt.Sprintf("https://%s.%s/w/api.php?action=query&list=search&srsearch=%s&srlimit=%d&format=json&utf8=1",
		lang, wl.WikiBaseURL, url.QueryEscape(query), maxResults)

	if !wl.IsAllowedURL(apiURL) {
		return nil, fmt.Errorf("SSRF prevention: blocked URL %q", apiURL)
	}

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("wikipedia request build failed: %w", err)
	}
	req.Header.Set("User-Agent", wl.UserAgent)

	resp, err := wl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wikipedia search failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wikipedia search returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, wl.BodyLimit))
	if err != nil {
		return nil, err
	}

	var result struct {
		Query struct {
			Search []struct {
				Title   string `json:"title"`
				Snippet string `json:"snippet"`
			} `json:"search"`
		} `json:"query"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	var results []SearchResult
	for _, s := range result.Query.Search {
		// Clean HTML tags from snippet
		clean := cleanHTML(s.Snippet)
		results = append(results, SearchResult{
			Title:   s.Title,
			Snippet: clean,
			Source:  "wikipedia-" + lang,
			URL:     fmt.Sprintf("https://%s.%s/wiki/%s", lang, wl.WikiBaseURL, url.PathEscape(s.Title)),
		})
	}
	return results, nil
}

// GetWikipediaSummary fetches a concise summary of a Wikipedia article.
func (wl *WebLearner) GetWikipediaSummary(title string, lang string) (*SearchResult, error) {
	wl.throttle()

	if lang == "" {
		lang = "en"
	}

	apiURL := fmt.Sprintf("https://%s.%s/api/rest_v1/page/summary/%s",
		lang, wl.WikiBaseURL, url.PathEscape(title))

	if !wl.IsAllowedURL(apiURL) {
		return nil, fmt.Errorf("SSRF prevention: blocked URL %q", apiURL)
	}

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("wikipedia summary request failed: %w", err)
	}
	req.Header.Set("User-Agent", wl.UserAgent)

	resp, err := wl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wikipedia summary failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wikipedia summary returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, wl.BodyLimit))
	if err != nil {
		return nil, err
	}

	var summary struct {
		Title   string `json:"title"`
		Extract string `json:"extract"`
	}
	if err := json.Unmarshal(body, &summary); err != nil {
		return nil, err
	}

	return &SearchResult{
		Title:   summary.Title,
		Content: summary.Extract,
		Source:  "wikipedia-" + lang,
		URL:     fmt.Sprintf("https://%s.%s/wiki/%s", lang, wl.WikiBaseURL, url.PathEscape(title)),
	}, nil
}

// LearnFromResults feeds search results into the Organism's learning pipeline.
func (wl *WebLearner) LearnFromResults(org *Organism, results []SearchResult) int {
	learned := 0
	for _, r := range results {
		text := r.Content
		if text == "" {
			text = r.Snippet
		}
		if text == "" {
			continue
		}

		// 1. Single canonical Q→A via LearnQA. This is the expensive
		//    path (Brain + Wernicke + Hippocampus + FractalCortex STDP
		//    + per-answer-token RadioCortex training), so we only run
		//    it once per result. Calling it for multiple paraphrases
		//    multiplies cost by N on a body of hundreds of tokens.
		if r.Title != "" {
			org.LearnQA("What is "+r.Title+"?", text)
			learned++

			// 2. Light-weight extra recall paths: store the same answer
			//    in the hippocampus under several question SDRs (and the
			//    bare title), without re-running STDP / RadioCortex. This
			//    is what gives the SDR-similarity path a chance against
			//    older generic memories that happen to share "what is".
			answerSDR := org.Encoder.EncodeSentence(text)
			for _, q := range extraRecallCues(r.Title) {
				qSDR := org.Encoder.EncodeSentence(q)
				org.Hippocampus.Store(qSDR, answerSDR, q+" | "+text)
				learned++
			}
		}

		// 3. Passive language learning: feed the body through Brain /
		//    Wernicke so word-association and n-gram statistics catch
		//    up with the new vocabulary.
		org.Brain.Learn(text)
		org.Wernicke.LearnContext(Tokenize(text))

		wl.TotalLearned += learned
	}
	wl.TotalFacts += learned
	return learned
}

// extraRecallCues returns light-weight question shapes used as
// additional Hippocampus index entries. These DO NOT trigger STDP or
// RadioCortex training (LearnQA handles that once); they only widen
// the SDR-similarity and keyword surface so a freshly-learned topic
// outranks older generic memories at recall time. Bilingual coverage
// (EN + RO) matches AutoSearchLangs defaults.
func extraRecallCues(title string) []string {
	t := strings.TrimSpace(title)
	if t == "" {
		return nil
	}
	return []string{
		t,                    // bare topic — "Saturn"
		"Tell me about " + t, // longer English phrasing
		"Ce este " + t + "?", // Romanian phrasing
	}
}

// -----------------------------------------------------------------------------
// HuggingFace Datasets API integration
// -----------------------------------------------------------------------------

// SearchHuggingFace searches the HuggingFace Datasets API for datasets
// matching the query. Returns up to maxResults results with dataset
// descriptions as content.
func (wl *WebLearner) SearchHuggingFace(query string, maxResults int) ([]SearchResult, error) {
	wl.throttle()
	wl.TotalSearches++

	if maxResults <= 0 {
		maxResults = 5
	}

	apiURL := fmt.Sprintf("%s?search=%s&limit=%d",
		wl.HFSearchURL, url.QueryEscape(query), maxResults)

	if !wl.IsAllowedURL(apiURL) {
		return nil, fmt.Errorf("SSRF prevention: blocked URL %q", apiURL)
	}

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("huggingface request build failed: %w", err)
	}
	req.Header.Set("User-Agent", wl.UserAgent)

	resp, err := wl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("huggingface search failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("huggingface search returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, wl.BodyLimit))
	if err != nil {
		return nil, err
	}

	var datasets []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
		Author      string `json:"author"`
		Downloads   int    `json:"downloads"`
	}
	if err := json.Unmarshal(body, &datasets); err != nil {
		return nil, fmt.Errorf("huggingface parse failed: %w", err)
	}

	var results []SearchResult
	for _, ds := range datasets {
		snippet := ds.Description
		if len(snippet) > 300 {
			snippet = snippet[:300] + "..."
		}
		results = append(results, SearchResult{
			Title:   ds.ID,
			Snippet: snippet,
			Content: ds.Description,
			URL:     "https://huggingface.co/datasets/" + ds.ID,
			Source:  "huggingface",
		})
	}
	return results, nil
}

// LearnFromHuggingFace fetches rows from a HuggingFace dataset and feeds them
// through the Organism's learning pipeline.
// It looks for common field patterns: instruction/output, question/answer,
// text, input/output, etc.
// Returns the count of items successfully learned.
func (wl *WebLearner) LearnFromHuggingFace(org *Organism, datasetID string, maxRows int) (int, error) {
	wl.throttle()

	if maxRows <= 0 {
		maxRows = 20
	}

	apiURL := fmt.Sprintf("%s?dataset=%s&config=default&split=train&offset=0&length=%d",
		wl.HFRowsURL, url.QueryEscape(datasetID), maxRows)

	if !wl.IsAllowedURL(apiURL) {
		return 0, fmt.Errorf("SSRF prevention: blocked URL %q", apiURL)
	}

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return 0, fmt.Errorf("huggingface rows request build failed: %w", err)
	}
	req.Header.Set("User-Agent", wl.UserAgent)

	resp, err := wl.Do(req)
	if err != nil {
		return 0, fmt.Errorf("huggingface rows fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("huggingface rows returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, wl.BodyLimit))
	if err != nil {
		return 0, err
	}

	// The rows API returns { "rows": [ { "row": { ... } }, ... ] }
	var result struct {
		Rows []struct {
			Row map[string]interface{} `json:"row"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, fmt.Errorf("huggingface rows parse failed: %w", err)
	}

	learned := 0
	for _, entry := range result.Rows {
		row := entry.Row
		if row == nil {
			continue
		}

		question, answer := extractQAPair(row)

		if question != "" && answer != "" {
			// Instruction/response style — use QA learning
			org.LearnQA(question, answer)
			learned++
		} else if text := extractTextField(row); text != "" {
			// Free-text style — passive learning
			org.Brain.Learn(text)
			tokens := Tokenize(text)
			org.Wernicke.LearnContext(tokens)
			learned++
		}
	}

	wl.TotalLearned += learned
	wl.TotalFacts += learned
	return learned, nil
}

// extractQAPair tries to find a question/answer pair from a HuggingFace row.
// Supports common field naming conventions.
func extractQAPair(row map[string]interface{}) (question, answer string) {
	// Try instruction/output (Alpaca-style)
	if q, ok := row["instruction"]; ok {
		question = asString(q)
	}
	if a, ok := row["output"]; ok {
		answer = asString(a)
	}
	if question != "" && answer != "" {
		// Append input if present (Alpaca has instruction + input + output)
		if inp, ok := row["input"]; ok {
			if s := asString(inp); s != "" {
				question = question + " " + s
			}
		}
		return
	}

	// Try question/answer (QA-style)
	if q, ok := row["question"]; ok {
		question = asString(q)
	}
	if a, ok := row["answer"]; ok {
		answer = asString(a)
	}
	if question != "" && answer != "" {
		return
	}

	// Try prompt/completion
	if q, ok := row["prompt"]; ok {
		question = asString(q)
	}
	if a, ok := row["completion"]; ok {
		answer = asString(a)
	}
	if question != "" && answer != "" {
		return
	}

	// Try ctx/endings (HellaSwag style)
	if q, ok := row["ctx"]; ok {
		question = asString(q)
	}
	if a, ok := row["endings"]; ok {
		answer = asString(a)
	}
	if question != "" && answer != "" {
		return
	}

	return "", ""
}

// extractTextField tries to find a free-text field from a HuggingFace row.
func extractTextField(row map[string]interface{}) string {
	for _, key := range []string{"text", "content", "sentence", "passage", "document"} {
		if v, ok := row[key]; ok {
			if s := asString(v); s != "" {
				return s
			}
		}
	}
	return ""
}

// asString converts an interface{} to string, handling common JSON types.
func asString(v interface{}) string {
	switch val := v.(type) {
	case string:
		return strings.TrimSpace(val)
	case float64:
		return fmt.Sprintf("%.0f", val)
	case []interface{}:
		// Join array elements (e.g. HellaSwag endings)
		parts := make([]string, 0, len(val))
		for _, item := range val {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, " | ")
	default:
		if v == nil {
			return ""
		}
		return fmt.Sprintf("%v", v)
	}
}

// cleanHTML removes HTML tags from a string (simple approach).
func cleanHTML(s string) string {
	var result strings.Builder
	inTag := false
	for _, r := range s {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			result.WriteRune(r)
		}
	}
	return strings.TrimSpace(result.String())
}
