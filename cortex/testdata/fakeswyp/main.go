// Command fakeswyp stands in for `swyp judge` in SwypJudgeChatTool tests.
// It echoes a verdict chosen by a marker in the submitted source.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "judge" {
		fmt.Fprintln(os.Stderr, "fakeswyp: want exactly the argument judge")
		os.Exit(2)
	}
	var req struct {
		Version  int             `json:"version"`
		Source   string          `json:"source"`
		Contract json.RawMessage `json:"contract"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil || req.Version != 1 {
		fmt.Fprintln(os.Stderr, "fakeswyp: bad request")
		os.Exit(2)
	}
	switch {
	case strings.Contains(req.Source, "SLEEP"):
		time.Sleep(time.Minute)
	case strings.Contains(req.Source, "GARBAGE"):
		fmt.Println("not json")
		os.Exit(1)
	case strings.Contains(req.Source, "x + x"):
		fmt.Println(`{"status":"counterexample","summary":"FAIL counterexample: square(x=-100) returned -200, violating ensures[0]"}`)
		os.Exit(1)
	default:
		fmt.Printf("{\"status\":\"exhaustive\",\"summary\":\"PASS exhaustive: %d-byte contract\"}\n", len(req.Contract))
	}
}
