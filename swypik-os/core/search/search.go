// Package search is Swypik's own search engine: a persistent inverted index,
// a polite same-origin web crawler and a local file indexer. Results come only
// from documents the user chose to index; no external search API is used.
package search

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	resourcepolicy "swypik-os/core/resource"
)

const (
	MaxDocuments = 20000
	MaxTextBytes = 16384
	maxLineBytes = 512 << 10
	logVersion   = 2
	// BM25F parameters. The title field is weighted above body text.
	k1, titleWeight, titleB, bodyB = 1.2, 3.0, 0.5, 0.75
)

type Document struct {
	URL       string    `json:"url"`
	Title     string    `json:"title"`
	Text      string    `json:"text"`
	FetchedAt time.Time `json:"fetched_at"`
	SHA256    string    `json:"sha256"`
}

type Source struct {
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Snippet   string    `json:"snippet"`
	Score     float64   `json:"score"`
	FetchedAt time.Time `json:"fetched_at"`
	SHA256    string    `json:"sha256"`
}

type Result struct {
	Query            string   `json:"query"`
	Sources          []Source `json:"sources"`
	Matches          int      `json:"matches"`
	LatencyMs        int64    `json:"latency_ms"`
	IndexedDocuments int      `json:"indexed_documents"`
}

type posting struct{ title, body int32 }

type record struct {
	Op  string    `json:"op"`
	Doc *Document `json:"doc,omitempty"`
	URL string    `json:"url,omitempty"`
}

type Engine struct {
	mu               sync.RWMutex
	crawlMu          sync.Mutex
	closed           bool
	path             string
	log              *os.File
	logBytes         int64
	docs             map[string]Document
	postings         map[string]map[string]posting
	titleLen         map[string]int
	bodyLen          map[string]int
	sumTitle         int
	sumBody          int
	vocab            []string // sorted; rebuilt lazily for prefix queries
	vocabOK          bool
	warnings         []string
	maxDocuments     int
	maxTextBytes     int
	profileTruncated bool
}

func (e *Engine) activeTextLimit() int {
	if e.maxTextBytes <= 0 || e.maxTextBytes > MaxTextBytes {
		return MaxTextBytes
	}
	return e.maxTextBytes
}

func (e *Engine) activeDocumentLimit() int {
	if e.maxDocuments <= 0 || e.maxDocuments > MaxDocuments {
		return MaxDocuments
	}
	return e.maxDocuments
}

// NewEngine returns an in-memory index (tests and ephemeral sessions).
func NewEngine() *Engine {
	e, _ := Open("")
	return e
}

func newEngine(path string) *Engine {
	policy := resourcepolicy.Default()
	return &Engine{
		path:         path,
		docs:         map[string]Document{},
		postings:     map[string]map[string]posting{},
		titleLen:     map[string]int{},
		bodyLen:      map[string]int{},
		maxDocuments: policy.SearchMaxDocuments,
		maxTextBytes: policy.SearchMaxTextBytes,
	}
}

// Open loads an append-only JSONL index. A torn final line (power loss during
// a write) is truncated. Any other corruption quarantines the file under a new
// name and keeps the documents read before the damage. Open never deletes data
// and never refuses to start because of index content; only I/O errors fail.
func Open(path string) (*Engine, error) {
	e := newEngine(path)
	if path == "" {
		return e, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	rewrite, err := e.replay()
	if err != nil {
		return nil, err
	}
	live := 0
	for _, d := range e.docs {
		live += len(d.Text) + len(d.Title) + 256
	}
	if e.profileTruncated {
		e.warnings = append(e.warnings, fmt.Sprintf(
			"index: resource profile loaded at most %d documents with %d bytes of text each; on-disk index was preserved",
			e.maxDocuments, e.maxTextBytes,
		))
	}
	if rewrite || (!e.profileTruncated && e.logBytes > int64(2*live)+(1<<20)) {
		if err := e.compactLocked(); err != nil {
			return nil, err
		}
	}
	if e.log == nil {
		if e.log, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0600); err != nil {
			return nil, err
		}
		if e.logBytes == 0 {
			if err := e.appendLocked(struct {
				Version int `json:"version"`
			}{logVersion}); err != nil {
				return nil, err
			}
		}
	}
	return e, nil
}

// replay reads the log. It reports whether the file must be rewritten.
func (e *Engine) replay() (bool, error) {
	f, err := os.Open(e.path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	var offset int64
	for lineNo := 0; ; lineNo++ {
		line, readErr := r.ReadSlice('\n')
		for readErr == bufio.ErrBufferFull {
			if len(line) > maxLineBytes {
				break
			}
			var more []byte
			more, readErr = r.ReadSlice('\n')
			line = append(append([]byte(nil), line...), more...)
		}
		if len(line) == 0 && readErr == io.EOF {
			e.logBytes = offset
			return false, nil
		}
		complete := readErr == nil
		if readErr != nil && readErr != io.EOF && readErr != bufio.ErrBufferFull {
			return false, readErr
		}
		if !complete && readErr == io.EOF {
			// Torn tail: the write never finished, so it was never acknowledged.
			f.Close()
			if err := os.Truncate(e.path, offset); err != nil {
				return false, err
			}
			e.warnings = append(e.warnings, "index: removed an incomplete final write")
			e.logBytes = offset
			return false, nil
		}
		if lineNo == 0 {
			var header struct {
				Version int `json:"version"`
			}
			if json.Unmarshal(line, &header) != nil || header.Version != logVersion {
				f.Close() // Windows cannot rename an open file.
				return true, e.quarantine("unsupported index header")
			}
		} else if err := e.applyLine(line); err != nil {
			f.Close()
			return true, e.quarantine(fmt.Sprintf("line %d: %v", lineNo+1, err))
		}
		offset += int64(len(line))
	}
}

func (e *Engine) applyLine(line []byte) error {
	if len(line) > maxLineBytes {
		return fmt.Errorf("record too large")
	}
	var rec record
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	if err := d.Decode(&rec); err != nil {
		return err
	}
	if err := d.Decode(new(json.RawMessage)); err != io.EOF {
		return fmt.Errorf("record must contain exactly one JSON object")
	}
	switch rec.Op {
	case "put":
		if rec.Doc == nil {
			return fmt.Errorf("put without document")
		}
		if err := validDocument(*rec.Doc); err != nil {
			e.warnings = append(e.warnings, "index: skipped invalid document "+rec.Doc.URL)
			return nil
		}
		maxDocuments := e.activeDocumentLimit()
		if _, exists := e.docs[rec.Doc.URL]; !exists && len(e.docs) >= maxDocuments {
			e.profileTruncated = true
			return nil
		}
		doc := *rec.Doc
		maxTextBytes := e.activeTextLimit()
		if len(doc.Text) > maxTextBytes {
			doc.Text = clip(doc.Text, maxTextBytes)
			e.profileTruncated = true
		}
		e.putLocked(doc)
	case "del":
		e.removeLocked(rec.URL)
	default:
		return fmt.Errorf("unknown operation")
	}
	return nil
}

func (e *Engine) quarantine(reason string) error {
	name := fmt.Sprintf("%s.corrupt-%s", e.path, time.Now().UTC().Format("20060102T150405"))
	if err := os.Rename(e.path, name); err != nil {
		return fmt.Errorf("quarantine damaged index: %w", err)
	}
	e.warnings = append(e.warnings, fmt.Sprintf("index damaged (%s); kept %d documents, original saved as %s", reason, len(e.docs), filepath.Base(name)))
	return nil
}

// Warnings reports repairs made while opening the index.
func (e *Engine) Warnings() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return append([]string(nil), e.warnings...)
}

func (e *Engine) appendLocked(v interface{}) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	n, err := e.log.Write(b)
	e.logBytes += int64(n)
	return err
}

// compactLocked writes the live documents to a new file and replaces the log.
func (e *Engine) compactLocked() error {
	if e.log != nil {
		if err := e.log.Close(); err != nil {
			return err
		}
		e.log = nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(e.path), ".index-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	w := bufio.NewWriter(tmp)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	err = enc.Encode(struct {
		Version int `json:"version"`
	}{logVersion})
	urls := make([]string, 0, len(e.docs))
	for u := range e.docs {
		urls = append(urls, u)
	}
	sort.Strings(urls)
	for _, u := range urls {
		if err != nil {
			break
		}
		d := e.docs[u]
		err = enc.Encode(record{Op: "put", Doc: &d})
	}
	if err == nil {
		err = w.Flush()
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(tmp.Name(), e.path); err != nil {
		return err
	}
	info, err := os.Stat(e.path)
	if err != nil {
		return err
	}
	e.logBytes = info.Size()
	e.log, err = os.OpenFile(e.path, os.O_WRONLY|os.O_APPEND, 0600)
	return err
}

// Close releases the log file. The engine must not be used afterwards.
func (e *Engine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closed = true
	if e.log == nil {
		return nil
	}
	err := e.log.Close()
	e.log = nil
	return err
}

func validURL(raw string) error {
	if strings.HasPrefix(raw, "file:") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "file" || u.Path == "" || u.RawQuery != "" || u.Fragment != "" || len(raw) > 4096 {
			return fmt.Errorf("invalid file URL")
		}
		return nil
	}
	c, err := canonical(raw)
	if err != nil {
		return err
	}
	if c != raw {
		return fmt.Errorf("URL is not canonical")
	}
	return nil
}

func validDocument(d Document) error {
	if err := validURL(d.URL); err != nil {
		return err
	}
	if len(d.Text) > MaxTextBytes || len(d.Title) > 512 || strings.TrimSpace(d.Text) == "" || !utf8.ValidString(d.Text) || !utf8.ValidString(d.Title) {
		return fmt.Errorf("invalid document text")
	}
	return nil
}

// putLocked adds or replaces a document and updates postings incrementally.
func (e *Engine) putLocked(d Document) {
	e.removeLocked(d.URL)
	title, body := tokenize(d.Title), tokenize(d.Text)
	for _, t := range title {
		p := e.postingFor(t, d.URL)
		p.title++
		e.postings[t][d.URL] = p
	}
	for _, t := range body {
		p := e.postingFor(t, d.URL)
		p.body++
		e.postings[t][d.URL] = p
	}
	e.docs[d.URL] = d
	e.titleLen[d.URL], e.bodyLen[d.URL] = len(title), len(body)
	e.sumTitle += len(title)
	e.sumBody += len(body)
	e.vocabOK = false
}

func (e *Engine) postingFor(term, id string) posting {
	m := e.postings[term]
	if m == nil {
		m = map[string]posting{}
		e.postings[term] = m
		e.vocabOK = false
	}
	return m[id]
}

func (e *Engine) removeLocked(id string) bool {
	d, ok := e.docs[id]
	if !ok {
		return false
	}
	removeTerms := func(terms []string) {
		for _, t := range terms {
			if m := e.postings[t]; m != nil {
				delete(m, id)
				if len(m) == 0 {
					delete(e.postings, t)
					e.vocabOK = false
				}
			}
		}
	}
	removeTerms(tokenize(d.Title))
	removeTerms(tokenize(d.Text))
	e.sumTitle -= e.titleLen[id]
	e.sumBody -= e.bodyLen[id]
	delete(e.titleLen, id)
	delete(e.bodyLen, id)
	delete(e.docs, id)
	return true
}

// Upsert stores one document durably before it becomes searchable.
func (e *Engine) Upsert(doc Document) error {
	_, err := e.UpsertMany([]Document{doc})
	return err
}

// UpsertMany appends documents with one fsync. The last occurrence of each URL
// wins. Unchanged documents (same title, text and non-empty hash) are skipped.
// It returns the number of distinct documents written and leaves docs unchanged.
func (e *Engine) UpsertMany(docs []Document) (int, error) {
	docs = append([]Document(nil), docs...)
	last := make(map[string]int, len(docs))
	maxTextBytes := e.activeTextLimit()
	for i := range docs {
		if len(docs[i].Text) > maxTextBytes {
			docs[i].Text = clip(docs[i].Text, maxTextBytes)
		}
		if err := validDocument(docs[i]); err != nil {
			return 0, fmt.Errorf("%s: %w", docs[i].URL, err)
		}
		last[docs[i].URL] = i
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return 0, fmt.Errorf("search index is closed")
	}
	var changed []Document
	added := 0
	for i, d := range docs {
		if last[d.URL] != i {
			continue
		}
		old, exists := e.docs[d.URL]
		if exists && old.SHA256 == d.SHA256 && old.Title == d.Title && old.Text == d.Text && d.SHA256 != "" {
			continue
		}
		if !exists {
			added++
		}
		changed = append(changed, d)
	}
	maxDocuments := e.activeDocumentLimit()
	if len(e.docs)+added > maxDocuments {
		return 0, fmt.Errorf("index document limit (%d) reached", maxDocuments)
	}
	if len(changed) == 0 {
		return 0, nil
	}
	if e.log != nil {
		for i := range changed {
			if err := e.appendLocked(record{Op: "put", Doc: &changed[i]}); err != nil {
				return 0, err
			}
		}
		if err := e.log.Sync(); err != nil {
			return 0, err
		}
	}
	for _, d := range changed {
		e.putLocked(d)
	}
	return len(changed), nil
}

// Delete removes a document. Deleting an absent URL does not write.
func (e *Engine) Delete(raw string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return fmt.Errorf("search index is closed")
	}
	if _, ok := e.docs[raw]; !ok {
		return nil
	}
	if e.log != nil {
		if err := e.appendLocked(record{Op: "del", URL: raw}); err != nil {
			return err
		}
		if err := e.log.Sync(); err != nil {
			return err
		}
	}
	e.removeLocked(raw)
	return nil
}

func (e *Engine) Count() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.docs)
}

// URLs returns indexed URLs with the given prefix (used by the local indexer
// to find files that disappeared).
func (e *Engine) URLs(prefix string) []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]string, 0, min(len(e.docs), 256))
	for u := range e.docs {
		if strings.HasPrefix(u, prefix) {
			out = append(out, u)
		}
	}
	sort.Strings(out)
	return out
}

func (e *Engine) prefixTerms(prefix string) []string {
	if !e.vocabOK {
		e.vocab = e.vocab[:0]
		for t := range e.postings {
			e.vocab = append(e.vocab, t)
		}
		sort.Strings(e.vocab)
		e.vocabOK = true
	}
	i := sort.SearchStrings(e.vocab, prefix)
	out := make([]string, 0, 32)
	for ; i < len(e.vocab) && strings.HasPrefix(e.vocab[i], prefix) && len(out) < 32; i++ {
		if e.vocab[i] != prefix {
			out = append(out, e.vocab[i])
		}
	}
	return out
}

// Search ranks documents with BM25F. Documents matching more query terms rank
// higher (coordination). The last term also matches as a prefix, so partial
// words find results while typing. Relevance is not proof of truth.
func (e *Engine) Search(query string) (*Result, error) {
	start := time.Now()
	query = strings.TrimSpace(query)
	if query == "" || len(query) > 512 {
		return nil, fmt.Errorf("query must contain 1-512 bytes")
	}
	// Prefix expansion reads and may rebuild the vocabulary cache.
	e.mu.Lock()
	defer e.mu.Unlock()
	result := &Result{Query: query, Sources: []Source{}, IndexedDocuments: len(e.docs)}
	terms := tokenize(query)
	if len(e.docs) == 0 || len(terms) == 0 {
		return result, nil
	}
	type weighted struct {
		term   string
		weight float64
		group  int
	}
	var expanded []weighted
	seen := map[string]bool{}
	groups := 0
	for i, t := range terms {
		if seen[t] {
			continue
		}
		seen[t] = true
		expanded = append(expanded, weighted{t, 1, groups})
		if i == len(terms)-1 && len([]rune(t)) >= 3 {
			for _, p := range e.prefixTerms(t) {
				expanded = append(expanded, weighted{p, 0.5, groups})
			}
		}
		groups++
	}
	n := float64(len(e.docs))
	avgTitle := math.Max(float64(e.sumTitle)/n, 1)
	avgBody := math.Max(float64(e.sumBody)/n, 1)
	scores := map[string]float64{}
	matched := map[string]map[int]bool{}
	highlight := map[string]bool{}
	for _, w := range expanded {
		docs := e.postings[w.term]
		if len(docs) == 0 {
			continue
		}
		highlight[w.term] = true
		df := float64(len(docs))
		idf := math.Log(1 + (n-df+0.5)/(df+0.5))
		for id, p := range docs {
			tf := titleWeight*float64(p.title)/(1-titleB+titleB*float64(e.titleLen[id])/avgTitle) +
				float64(p.body)/(1-bodyB+bodyB*float64(e.bodyLen[id])/avgBody)
			scores[id] += w.weight * idf * tf / (k1 + tf)
			if matched[id] == nil {
				matched[id] = map[int]bool{}
			}
			matched[id][w.group] = true
		}
	}
	for id, score := range scores {
		score *= float64(len(matched[id])) / float64(groups)
		d := e.docs[id]
		result.Sources = append(result.Sources, Source{Title: d.Title, URL: d.URL, Score: score, FetchedAt: d.FetchedAt, SHA256: d.SHA256})
	}
	result.Matches = len(result.Sources)
	sort.Slice(result.Sources, func(i, j int) bool {
		a, b := result.Sources[i], result.Sources[j]
		if a.Score == b.Score {
			return a.URL < b.URL
		}
		return a.Score > b.Score
	})
	if len(result.Sources) > 20 {
		result.Sources = result.Sources[:20]
	}
	for i := range result.Sources {
		result.Sources[i].Snippet = snippet(e.docs[result.Sources[i].URL].Text, highlight)
	}
	result.LatencyMs = time.Since(start).Milliseconds()
	return result, nil
}

// ImportLegacy migrates a version-1 JSON index into this engine. The legacy
// file is renamed with a .migrated suffix only after the import succeeded.
func (e *Engine) ImportLegacy(path string) (int, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var disk struct {
		Version   int        `json:"version"`
		Documents []Document `json:"documents"`
	}
	err = json.NewDecoder(io.LimitReader(f, 64<<20)).Decode(&disk)
	f.Close()
	if err != nil || disk.Version != 1 {
		return 0, fmt.Errorf("legacy index unreadable; left in place: %v", err)
	}
	var valid []Document
	for _, d := range disk.Documents {
		if c, cerr := canonical(d.URL); cerr == nil {
			d.URL = c
			d.Text = clip(d.Text, MaxTextBytes)
			if validDocument(d) == nil {
				valid = append(valid, d)
			}
		}
	}
	n, err := e.UpsertMany(valid)
	if err != nil {
		return 0, err
	}
	return n, os.Rename(path, path+".migrated")
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
