// export-evalsuite-jsonl — converts the canonical broca-eval suite
// (cortex/evalsuite.Standard, 24 tasks across factual/math/instruct/
// reasoning) into the JSONL format that cortex-eval consumes.
//
// Why this exists: today broca-eval and cortex-eval evaluate the SAME
// model via two different paths — broca-eval calls the raw transformer
// only, cortex-eval calls org.Process which routes through Hippocampus
// + Reasoning + Prefrontal + Transformer. To do an apples-to-apples
// before/after comparison ("is the cognitive pipeline actually adding
// value?") we need both harnesses to grade against the exact same 24
// prompts. This dumps Standard → JSONL once so cortex-eval can read it.
//
// Output schema (one JSON object per line):
//
//	{
//	  "input":    "What is the capital of France?",
//	  "expected": "paris",
//	  "category": "factual"
//	}
//
// Notes on the mapping:
//   - ModeContains / ModeContainsAny: we emit Expected[0] verbatim.
//     cortex-eval does a Jaccard word-overlap check, so as long as one
//     of the acceptable answers shows up in the response it counts.
//   - ModeNumeric: we emit ExpectedNumber formatted as the shortest
//     decimal that round-trips (e.g. 42 → "42", 0.9 → "0.9"). The
//     overlap check sees the digits as a token and matches if present.
//   - ModeRegex: we emit the raw pattern; cortex-eval cannot interpret
//     regex, so these tasks are best-effort. Standard suite currently
//     has zero ModeRegex tasks (verified 2026-05-26), so this is a
//     forward-compat fallback, not a real concern.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"

	"ilaria/cortex/evalsuite"
)

type jsonlLine struct {
	Input    string `json:"input"`
	Expected string `json:"expected"`
	Category string `json:"category"`
}

func main() {
	out := flag.String("out", "data/evals/broca-suite.jsonl", "Output JSONL path")
	flag.Parse()

	f, err := os.Create(*out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create %s: %v\n", *out, err)
		os.Exit(1)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	for _, t := range evalsuite.Standard {
		expected := ""
		switch t.Mode {
		case evalsuite.ModeNumeric:
			// Shortest decimal representation that round-trips.
			expected = strconv.FormatFloat(t.ExpectedNumber, 'f', -1, 64)
		case evalsuite.ModeContains, evalsuite.ModeContainsAny:
			if len(t.Expected) > 0 {
				expected = t.Expected[0]
			}
		case evalsuite.ModeRegex:
			if len(t.Expected) > 0 {
				expected = t.Expected[0] // raw pattern; cortex-eval treats as plain string
			}
		default:
			if len(t.Expected) > 0 {
				expected = t.Expected[0]
			}
		}
		if err := enc.Encode(jsonlLine{
			Input:    t.Prompt,
			Expected: expected,
			Category: string(t.Category),
		}); err != nil {
			fmt.Fprintf(os.Stderr, "encode %s: %v\n", t.ID, err)
			os.Exit(1)
		}
	}
	fmt.Printf("Wrote %d tasks to %s\n", len(evalsuite.Standard), *out)
}
