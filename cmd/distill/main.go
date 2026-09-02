package main

// distill — harvest instruction/response pairs from an LLM API into the
// JSONL corpus format Nexuscortex already ingests.
//
// WHY THIS EXISTS
//
// Nexus cannot be pre-trained from scratch on this hardware, but it does
// not have to be: a larger model can act as a teacher. This tool asks a
// teacher model a curriculum of prompts and writes the answers as
// {"instruction","response"} lines — byte-identical to the format
// cmd/bulk-ingest and the corpus loader already read. Nothing downstream
// needs to change.
//
// DESIGN NOTES
//
//   - Provider-agnostic: any OpenAI-compatible /chat/completions endpoint
//     works (OpenAI, DeepSeek, Groq, OpenRouter, a local llama.cpp server).
//     Anthropic is supported via its own message shape.
//   - RESUMABLE: output is appended, and prompts already present in the
//     output file are skipped. A crashed or rate-limited run costs nothing
//     to restart — this matters when a harvest is thousands of calls.
//   - Bounded concurrency with retry/backoff on 429 and 5xx.
//   - Never invents data: on failure it reports the error and skips the
//     prompt rather than writing a placeholder.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// qaPair is the corpus line format. Field names must match what
// cmd/bulk-ingest expects (see cmd/bulk-ingest/main.go: qaEntry).
type qaPair struct {
	Instruction string `json:"instruction"`
	Response    string `json:"response"`
}

type config struct {
	promptFile  string
	outFile     string
	endpoint    string
	model       string
	apiKeyEnv   string
	provider    string
	system      string
	concurrency int
	maxTokens   int
	temperature float64
	limit       int
	dryRun      bool
	timeout     time.Duration
}

func main() {
	cfg := config{}
	flag.StringVar(&cfg.promptFile, "prompts", "", "File of prompts, one per line (required)")
	flag.StringVar(&cfg.outFile, "out", "./data/corpus/distilled.jsonl", "Output JSONL path (appended)")
	flag.StringVar(&cfg.endpoint, "endpoint", "https://ai.codai.ro/v1/chat/completions", "Chat completions endpoint")
	flag.StringVar(&cfg.model, "model", "codai", "Teacher model name")
	flag.StringVar(&cfg.apiKeyEnv, "key-env", "CODAI_API_KEY", "Env var holding the API key")
	flag.StringVar(&cfg.provider, "provider", "openai", "Wire format: openai|anthropic")
	flag.StringVar(&cfg.system, "system", "You are a precise teacher. Answer correctly and concisely. Show brief step-by-step reasoning when the question requires it.", "System prompt")
	flag.IntVar(&cfg.concurrency, "concurrency", 4, "Parallel in-flight requests")
	flag.IntVar(&cfg.maxTokens, "max-tokens", 512, "Max tokens per response")
	flag.Float64Var(&cfg.temperature, "temperature", 0.3, "Sampling temperature")
	flag.IntVar(&cfg.limit, "limit", 0, "Max prompts to process (0 = all)")
	flag.BoolVar(&cfg.dryRun, "dry-run", false, "Show what would run; make no API calls")
	flag.DurationVar(&cfg.timeout, "timeout", 90*time.Second, "Per-request timeout")
	flag.Parse()

	if cfg.promptFile == "" {
		fmt.Fprintln(os.Stderr, "error: -prompts is required")
		flag.Usage()
		os.Exit(2)
	}

	prompts, err := readLines(cfg.promptFile)
	if err != nil {
		fatal("read prompts: %v", err)
	}
	if len(prompts) == 0 {
		fatal("prompt file %s contained no usable lines", cfg.promptFile)
	}

	// Resume: skip prompts already harvested.
	done, err := existingInstructions(cfg.outFile)
	if err != nil {
		fatal("scan existing output: %v", err)
	}
	pending := make([]string, 0, len(prompts))
	for _, p := range prompts {
		if !done[p] {
			pending = append(pending, p)
		}
	}
	if cfg.limit > 0 && len(pending) > cfg.limit {
		pending = pending[:cfg.limit]
	}

	fmt.Printf("[distill] prompts=%d already-done=%d pending=%d\n", len(prompts), len(done), len(pending))
	fmt.Printf("[distill] provider=%s model=%s endpoint=%s\n", cfg.provider, cfg.model, cfg.endpoint)
	fmt.Printf("[distill] out=%s concurrency=%d\n", cfg.outFile, cfg.concurrency)

	if len(pending) == 0 {
		fmt.Println("[distill] nothing to do — output already complete")
		return
	}
	if cfg.dryRun {
		fmt.Println("[distill] DRY RUN — no API calls made. First 3 pending prompts:")
		for i, p := range pending {
			if i >= 3 {
				break
			}
			fmt.Printf("  %d. %s\n", i+1, truncate(p, 100))
		}
		return
	}

	apiKey := os.Getenv(cfg.apiKeyEnv)
	if apiKey == "" {
		fatal("env var %s is empty — export your API key first", cfg.apiKeyEnv)
	}

	out, err := os.OpenFile(cfg.outFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fatal("open output: %v", err)
	}
	defer out.Close()

	client := &http.Client{Timeout: cfg.timeout}

	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		sem      = make(chan struct{}, cfg.concurrency)
		ok, fail int
	)
	start := time.Now()

	for i, prompt := range pending {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, p string) {
			defer wg.Done()
			defer func() { <-sem }()

			answer, err := callWithRetry(client, cfg, apiKey, p)

			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				fail++
				fmt.Fprintf(os.Stderr, "[distill] FAIL %q: %v\n", truncate(p, 60), err)
				return
			}
			line, mErr := json.Marshal(qaPair{Instruction: p, Response: answer})
			if mErr != nil {
				fail++
				fmt.Fprintf(os.Stderr, "[distill] marshal error: %v\n", mErr)
				return
			}
			if _, wErr := out.Write(append(line, '\n')); wErr != nil {
				fail++
				fmt.Fprintf(os.Stderr, "[distill] write error: %v\n", wErr)
				return
			}
			ok++
			if ok%10 == 0 {
				fmt.Printf("[distill] %d/%d ok (%d failed) %.1fs\n",
					ok, len(pending), fail, time.Since(start).Seconds())
			}
		}(i, prompt)
	}
	wg.Wait()

	fmt.Printf("[distill] DONE ok=%d failed=%d elapsed=%.1fs -> %s\n",
		ok, fail, time.Since(start).Seconds(), cfg.outFile)
	if ok > 0 {
		fmt.Printf("[distill] next: go run ./cmd/bulk-ingest -corpus %s\n", cfg.outFile)
	}
	if fail > 0 {
		// Non-zero exit so a CI/scripted harvest notices partial failure.
		os.Exit(1)
	}
}

// callWithRetry issues the request, retrying on rate limits and transient
// server errors with exponential backoff plus jitter.
func callWithRetry(c *http.Client, cfg config, key, prompt string) (string, error) {
	const maxAttempts = 5
	var lastErr error

	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			// Exponential backoff with jitter avoids a thundering herd
			// when many workers get rate-limited simultaneously.
			base := time.Duration(1<<uint(attempt-1)) * time.Second
			jitter := time.Duration(rand.Int63n(int64(500 * time.Millisecond)))
			time.Sleep(base + jitter)
		}

		answer, retryable, err := callOnce(c, cfg, key, prompt)
		if err == nil {
			return answer, nil
		}
		lastErr = err
		if !retryable {
			return "", err
		}
	}
	return "", fmt.Errorf("exhausted retries: %w", lastErr)
}

// callOnce performs a single API request. The bool reports whether the
// failure is worth retrying.
func callOnce(c *http.Client, cfg config, key, prompt string) (string, bool, error) {
	body, err := buildRequest(cfg, prompt)
	if err != nil {
		return "", false, err
	}

	req, err := http.NewRequest("POST", cfg.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Content-Type", "application/json")

	switch cfg.provider {
	case "anthropic":
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	default:
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := c.Do(req)
	if err != nil {
		return "", true, err // network errors are worth retrying
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", true, err
	}

	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return "", true, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	if resp.StatusCode != 200 {
		// 4xx other than 429 (bad key, bad model) will not fix themselves.
		return "", false, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}

	text, err := parseResponse(cfg.provider, raw)
	if err != nil {
		return "", false, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", true, fmt.Errorf("empty completion")
	}
	return text, false, nil
}

func buildRequest(cfg config, prompt string) ([]byte, error) {
	if cfg.provider == "anthropic" {
		return json.Marshal(map[string]any{
			"model":      cfg.model,
			"max_tokens": cfg.maxTokens,
			"system":     cfg.system,
			"messages": []map[string]string{
				{"role": "user", "content": prompt},
			},
		})
	}
	return json.Marshal(map[string]any{
		"model":       cfg.model,
		"max_tokens":  cfg.maxTokens,
		"temperature": cfg.temperature,
		"messages": []map[string]string{
			{"role": "system", "content": cfg.system},
			{"role": "user", "content": prompt},
		},
	})
}

func parseResponse(provider string, raw []byte) (string, error) {
	if provider == "anthropic" {
		var r struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return "", fmt.Errorf("decode anthropic response: %w", err)
		}
		if len(r.Content) == 0 {
			return "", fmt.Errorf("anthropic response had no content block")
		}
		return r.Content[0].Text, nil
	}

	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", fmt.Errorf("decode openai response: %w", err)
	}
	if len(r.Choices) == 0 {
		return "", fmt.Errorf("response had no choices")
	}
	return r.Choices[0].Message.Content, nil
}

// existingInstructions returns the set of prompts already in the output,
// so a re-run resumes instead of duplicating (and re-paying for) work.
func existingInstructions(path string) (map[string]bool, error) {
	seen := make(map[string]bool)
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return seen, nil
		}
		return nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var q qaPair
		if err := json.Unmarshal(line, &q); err != nil {
			continue // tolerate a partially written trailing line
		}
		if q.Instruction != "" {
			seen[q.Instruction] = true
		}
	}
	return seen, sc.Err()
}

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []string
	seen := make(map[string]bool)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if seen[line] { // de-duplicate the curriculum itself
			continue
		}
		seen[line] = true
		out = append(out, line)
	}
	return out, sc.Err()
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
