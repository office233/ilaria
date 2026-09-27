// ternary-demo executes an explicit ternary matrix file without a model.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"swyp-lang/experiments/ternary"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: ternary-demo program.json")
	}
	f, err := os.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4*1024*1024+1))
	if err != nil {
		return err
	}
	if len(data) > 4*1024*1024 {
		return fmt.Errorf("file too large")
	}
	var request struct {
		Program ternary.Program `json:"program"`
		Input   []float64       `json:"input"`
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(&request); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	g, err := ternary.Compile(request.Program)
	if err != nil {
		return err
	}
	y := make([]float64, request.Program.Outputs)
	if err = g.EvalInto(request.Input, y); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"output": y, "packed_weight_bytes": g.WeightBytes(), "float64_weight_bytes": len(request.Program.Weights) * 8, "semantics": "y = W*x; row-major ternary weights"})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
