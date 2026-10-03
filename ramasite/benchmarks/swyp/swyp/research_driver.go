//go:build ignore

// Build explicitly: go build -o <new-path> benchmarks/swyp/research_driver.go
// Compares historical and current bytecode in the SAME current VM and process.
package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"time"

	"swyp-lang/internal/swyplang"
)

type sample struct {
	Variant  string  `json:"variant"`
	Round    int     `json:"round"`
	NSPerRun float64 `json:"ns_per_run"`
}

type summary struct {
	Variant      string  `json:"variant"`
	MedianNS     float64 `json:"median_ns"`
	MinNS        float64 `json:"min_ns"`
	MaxNS        float64 `json:"max_ns"`
	Instructions int     `json:"instructions"`
	ModuleBytes  int     `json:"module_bytes"`
	Steps        int     `json:"steps"`
}

func run() error {
	if len(os.Args) < 3 {
		return fmt.Errorf("usage: research_driver compare-modules <module>... | emit-js <source>")
	}
	if os.Args[1] == "emit-js" {
		if len(os.Args) != 3 {
			return fmt.Errorf("emit-js requires one source")
		}
		b, e := os.ReadFile(os.Args[2])
		if e != nil {
			return e
		}
		p, e := swyplang.Parse(os.Args[2], string(b))
		if e != nil {
			return e
		}
		js, e := p.EmitJS()
		if e != nil {
			return e
		}
		_, e = fmt.Fprintln(os.Stdout, js+"\nswypRun(process.argv.slice(2).map(Number),console.log);")
		return e
	}
	if os.Args[1] != "compare-modules" {
		return fmt.Errorf("unknown command %q", os.Args[1])
	}
	const loops = 8000
	const rounds = 9
	args := []int64{1000}
	paths := os.Args[2:]
	modules := make([]*swyplang.STV2Module, len(paths))
	sizes := make([]int, len(paths))
	steps := make([]int, len(paths))
	for i, p := range paths {
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		sizes[i] = len(b)
		modules[i], e = swyplang.LoadSWYPB(b)
		if e != nil {
			return e
		}
		for j := 0; j < 200; j++ {
			r, e := modules[i].Run(args, 100000)
			if e != nil {
				return e
			}
			if r.Value != 500500 {
				return fmt.Errorf("%s returned %d", p, r.Value)
			}
			steps[i] = r.Steps
		}
	}
	rng := rand.New(rand.NewSource(20260928))
	rows := make([]sample, 0, len(paths)*rounds)
	for round := 0; round < rounds; round++ {
		for _, i := range rng.Perm(len(paths)) {
			start := time.Now()
			for j := 0; j < loops; j++ {
				r, e := modules[i].Run(args, 100000)
				if e != nil {
					return e
				}
				if r.Value != 500500 {
					return fmt.Errorf("result changed: %s", paths[i])
				}
			}
			rows = append(rows, sample{filepath.Base(paths[i]), round, float64(time.Since(start).Nanoseconds()) / loops})
		}
	}
	stats := make([]summary, 0, len(paths))
	for i, p := range paths {
		name := filepath.Base(p)
		var times []float64
		for _, r := range rows {
			if r.Variant == name {
				times = append(times, r.NSPerRun)
			}
		}
		sort.Float64s(times)
		stats = append(stats, summary{name, times[len(times)/2], times[0], times[len(times)-1], modules[i].InstructionCount(), sizes[i], steps[i]})
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"method": "same process and VM; identical input; 200 warmups/module; serial randomized variant order per round; successful value checked every run",
		"seed":   20260928, "runs_per_sample": loops, "rounds": rounds, "argument": 1000,
		"limitations": "single Windows host; not a confidence interval or universal speed claim; result checking and public VM validation included",
		"samples":     rows, "summary": stats,
	})
}

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
