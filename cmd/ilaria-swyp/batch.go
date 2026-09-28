package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	cortex "ilaria/cortex"
)

// Batch mode (-tasks): one model load runs many Swyp Forge tasks
// (swyp/examples/swyp/tasks/tasks.jsonl) and writes one JSONL result per task.
// pass@1 = verified on the first reply; repair@N = verified within N replies.

type forgeTask struct {
	ID       string          `json:"id"`
	Tier     string          `json:"tier"`
	Split    string          `json:"split"`
	Task     string          `json:"task"`
	Contract json.RawMessage `json:"contract"`
}

type batchResult struct {
	ID            string                 `json:"id"`
	Tier          string                 `json:"tier"`
	Split         string                 `json:"split"`
	Status        string                 `json:"status"` // verified | unverified | infra_error
	Replies       int                    `json:"replies"`
	VerifiedRound int                    `json:"verified_round,omitempty"`
	Error         string                 `json:"error,omitempty"`
	Seconds       float64                `json:"seconds"`
	Report        cortex.SwypSolveReport `json:"report"`
}

type tierScore struct {
	Tasks, Pass1, Verified, InfraErrors int
}

type batchSummary struct {
	Rounds int                   `json:"rounds"`
	Total  tierScore             `json:"total"`
	ByTier map[string]*tierScore `json:"by_tier"`
}

func readForgeTasks(r io.Reader, split string) ([]forgeTask, error) {
	if split != "heldout" && split != "train" && split != "all" {
		return nil, fmt.Errorf("-split must be heldout, train or all")
	}
	var tasks []forgeTask
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	seen := map[string]bool{}
	for line := 1; sc.Scan(); line++ {
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		var t forgeTask
		if err := json.Unmarshal([]byte(text), &t); err != nil {
			return nil, fmt.Errorf("tasks line %d: %w", line, err)
		}
		if t.ID == "" || t.Task == "" || len(t.Contract) == 0 || seen[t.ID] {
			return nil, fmt.Errorf("tasks line %d: id, task and contract are required and ids must be unique", line)
		}
		seen[t.ID] = true
		if split == "all" || t.Split == split {
			tasks = append(tasks, t)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return nil, fmt.Errorf("no tasks in split %q", split)
	}
	return tasks, nil
}

// classify turns one solve report into a batch result. An infrastructure
// error (model or verifier unusable, e.g. a judge timeout) is kept apart from
// an honest "unverified": it is neither a pass nor evidence of a wrong model.
func classify(t forgeTask, report cortex.SwypSolveReport, err error, elapsed time.Duration) batchResult {
	res := batchResult{ID: t.ID, Tier: t.Tier, Split: t.Split, Status: report.Status, Replies: len(report.Attempts),
		Seconds: elapsed.Seconds(), Report: report}
	if err != nil {
		res.Status, res.Error = "infra_error", err.Error()
	}
	if res.Status == "verified" {
		res.VerifiedRound = report.Attempts[len(report.Attempts)-1].Round
	}
	return res
}

func summarize(results []batchResult, rounds int) batchSummary {
	s := batchSummary{Rounds: rounds, ByTier: map[string]*tierScore{}}
	for _, r := range results {
		tier := s.ByTier[r.Tier]
		if tier == nil {
			tier = &tierScore{}
			s.ByTier[r.Tier] = tier
		}
		for _, sc := range []*tierScore{&s.Total, tier} {
			sc.Tasks++
			switch r.Status {
			case "verified":
				sc.Verified++
				if r.VerifiedRound == 1 {
					sc.Pass1++
				}
			case "infra_error":
				sc.InfraErrors++
			}
		}
	}
	return s
}

func (s batchSummary) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%-12s %5s %7s %9s %6s\n", "tier", "tasks", "pass@1", fmt.Sprintf("repair@%d", s.Rounds), "infra")
	tiers := make([]string, 0, len(s.ByTier))
	for t := range s.ByTier {
		tiers = append(tiers, t)
	}
	sort.Strings(tiers)
	row := func(name string, t tierScore) {
		fmt.Fprintf(&b, "%-12s %5d %7d %9d %6d\n", name, t.Tasks, t.Pass1, t.Verified, t.InfraErrors)
	}
	for _, t := range tiers {
		row(t, *s.ByTier[t])
	}
	row("total", s.Total)
	return b.String()
}

func runBatch(ctx context.Context, tasks []forgeTask, rounds int, reportPath string,
	generate cortex.SwypGenerator, verify cortex.SwypVerifier) (batchSummary, error) {
	f, err := os.OpenFile(reportPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return batchSummary{}, fmt.Errorf("report must be a new file: %w", err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	var results []batchResult
	for i, t := range tasks {
		if err := ctx.Err(); err != nil {
			return summarize(results, rounds), err
		}
		start := time.Now()
		report, err := cortex.SolveWithSwyp(ctx, t.Task, t.Contract, rounds, generate, verify)
		res := classify(t, report, err, time.Since(start))
		results = append(results, res)
		if err := enc.Encode(res); err != nil {
			return summarize(results, rounds), err
		}
		fmt.Fprintf(os.Stderr, "[ilaria-swyp] %d/%d %s: %s in %d repl(ies)\n", i+1, len(tasks), t.ID, res.Status, res.Replies)
	}
	s := summarize(results, rounds)
	return s, enc.Encode(map[string]any{"summary": s})
}
