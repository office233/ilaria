package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"

	"swyp-lang/internal/swyplang"
	"swyp-lang/internal/synthesis"
)

type workerResponse struct {
	Version      int                        `json:"version"`
	Status       string                     `json:"status"`
	Evidence     string                     `json:"evidence"`
	SourceSHA256 string                     `json:"source_sha256"`
	Graph        swyplang.Graph             `json:"graph"`
	Result       synthesis.RefinementResult `json:"result"`
}

// One bounded stdin request, one JSON response. No network, file writes,
// external compilers or arbitrary generated-code execution in this protocol.
func worker(ctx context.Context, input io.Reader, output io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(input, 64*1024+1))
	if err != nil {
		return err
	}
	if len(data) > 64*1024 {
		return fmt.Errorf("worker request exceeds 64 KiB")
	}
	spec, validation, err := decodeSynthInput(data)
	if err != nil {
		return err
	}
	result, err := synthesis.SynthesizeWithValidation(ctx, spec, validation)
	if err != nil {
		return err
	}
	p, err := swyplang.Parse("worker.swyp", result.Source)
	if err != nil {
		return err
	}
	graph, err := p.ExpressionGraph("predict")
	if err != nil {
		return err
	}
	for _, examples := range [][]synthesis.Example{spec.Examples, validation} {
		for _, e := range examples {
			if err := ctx.Err(); err != nil {
				return err
			}
			y, err := graph.Evaluate(e.X, 64)
			if err != nil || y != e.Y {
				return fmt.Errorf("source/graph mismatch for x=%g", e.X)
			}
		}
	}
	digest := sha256.Sum256([]byte(result.Source))
	return json.NewEncoder(output).Encode(workerResponse{Version: 1, Status: "candidate",
		Evidence:     "Matches supplied points only; not approved for automatic replacement.",
		SourceSHA256: hex.EncodeToString(digest[:]), Graph: graph, Result: result})
}
