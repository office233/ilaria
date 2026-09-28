package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cortex "ilaria/cortex"
)

const batchTasks = `{"id":"sq","tier":"arithmetic","split":"heldout","task":"Return x squared.","contract":{"version":1,"entry":"sq","inputs":[{"name":"x","type":"i64","min":"0","max":"3"}],"ensures":[],"max_steps":10}}
{"id":"neg","tier":"arithmetic","split":"train","task":"Return -x.","contract":{"version":1,"entry":"neg","inputs":[{"name":"x","type":"i64","min":"0","max":"3"}],"ensures":[],"max_steps":10}}
{"id":"abs","tier":"branches","split":"heldout","task":"Return |x|.","contract":{"version":1,"entry":"abs","inputs":[{"name":"x","type":"i64","min":"0","max":"3"}],"ensures":[],"max_steps":10}}
{"id":"slow","tier":"branches","split":"heldout","task":"Anything.","contract":{"version":1,"entry":"slow","inputs":[{"name":"x","type":"i64","min":"0","max":"3"}],"ensures":[],"max_steps":10}}
`

func TestReadForgeTasksSplits(t *testing.T) {
	for split, want := range map[string]int{"heldout": 3, "train": 1, "all": 4} {
		got, err := readForgeTasks(strings.NewReader(batchTasks), split)
		if err != nil || len(got) != want {
			t.Fatalf("%s: %d tasks, %v", split, len(got), err)
		}
	}
	if _, err := readForgeTasks(strings.NewReader(batchTasks), "test"); err == nil {
		t.Fatal("accepted unknown split")
	}
	dup := batchTasks + strings.SplitN(batchTasks, "\n", 2)[0] + "\n"
	if _, err := readForgeTasks(strings.NewReader(dup), "all"); err == nil {
		t.Fatal("accepted duplicate id")
	}
}

func TestRunBatchScoresPassRepairAndInfra(t *testing.T) {
	tasks, err := readForgeTasks(strings.NewReader(batchTasks), "heldout")
	if err != nil {
		t.Fatal(err)
	}
	// sq: right first time; abs: wrong, then repaired; slow: verifier times out.
	replies := map[string][]string{
		"sq":   {"```swyp\nfn sq(x: i64) -> i64 { return x * x; }\n```"},
		"abs":  {"```swyp\nfn abs(x: i64) -> i64 { return x; }\n```", "```swyp\nfn abs(x: i64) -> i64 { if x < 0 { return -x; } return x; }\n```"},
		"slow": {"```swyp\nfn slow(x: i64) -> i64 { return x; }\n```"},
	}
	var prompts []string
	next := map[string]int{}
	generate := func(_ context.Context, prompt string) (string, error) {
		prompts = append(prompts, prompt)
		for id, r := range replies {
			if strings.Contains(prompt, "fn "+id+"(") {
				i := next[id]
				next[id]++
				return r[i], nil
			}
		}
		return "", errors.New("unexpected prompt")
	}
	verify := func(_ context.Context, source string, _ json.RawMessage) (cortex.SwypVerdict, error) {
		switch {
		case strings.Contains(source, "fn slow"):
			return cortex.SwypVerdict{}, errors.New("swyp judge timed out after 10s")
		case strings.Contains(source, "return x;") && strings.Contains(source, "fn abs") && !strings.Contains(source, "-x"):
			return cortex.SwypVerdict{Status: "counterexample", Summary: "FAIL counterexample: abs(x=-1) returned -1"}, nil
		}
		return cortex.SwypVerdict{Status: "exhaustive", Summary: "PASS exhaustive"}, nil
	}
	path := filepath.Join(t.TempDir(), "report.jsonl")
	s, err := runBatch(context.Background(), tasks, 4, path, generate, verify)
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != (tierScore{Tasks: 3, Pass1: 1, Verified: 2, InfraErrors: 1}) {
		t.Fatalf("total %+v", s.Total)
	}
	if *s.ByTier["branches"] != (tierScore{Tasks: 2, Pass1: 0, Verified: 1, InfraErrors: 1}) {
		t.Fatalf("branches %+v", *s.ByTier["branches"])
	}
	if !strings.Contains(prompts[2], "The verifier says: FAIL counterexample: abs(x=-1) returned -1") {
		t.Fatalf("repair prompt %q", prompts[2])
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if len(lines) != 4 || !strings.Contains(lines[1], `"verified_round":2`) || !strings.Contains(lines[3], `"summary"`) {
		t.Fatalf("report lines: %q", lines)
	}
	if _, err := runBatch(context.Background(), tasks, 4, path, generate, verify); err == nil {
		t.Fatal("overwrote an existing report")
	}
	if !strings.Contains(s.String(), "repair@4") {
		t.Fatalf("table %q", s.String())
	}
}
