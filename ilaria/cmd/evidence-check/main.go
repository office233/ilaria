// evidence-check verifies explicit effect envelopes using caller-supplied trust.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	effects "ilaria/generated/swypeffects"
	"ilaria/runtime/evidence"
)

const maxSmallEnvelopeBytes = 64 << 10

func readEnvelope(path string, destination any, limit int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("envelope must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("envelope must be a regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) > limit {
		return fmt.Errorf("envelope exceeds %d bytes", limit)
	}
	return evidence.DecodeStrict(raw, destination)
}

func run(args []string, output io.Writer) error {
	return runWithInput(args, os.Stdin, output)
}

func loadVerifier(keysPath string) (*evidence.Verifier, error) {
	var registry evidence.TrustRegistry
	if err := readEnvelope(keysPath, &registry, evidence.MaxJSONBytes); err != nil {
		return nil, fmt.Errorf("read %s: %w", keysPath, err)
	}
	if registry.Format != evidence.TrustRegistryFormat {
		return nil, fmt.Errorf("unsupported public-key registry format")
	}
	return evidence.NewVerifier(registry.Keys)
}

func runWithInput(args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("evidence-check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	stream := flags.Bool("stream", false, "verify one bounded JSONL envelope at a time on stdin")
	requestPath := flags.String("request", "", "EffectRequest JSON file")
	resultPath := flags.String("result", "", "EffectResult JSON file (base64 payload)")
	receiptPath := flags.String("receipt", "", "signed EffectReceipt JSON file")
	expectedPath := flags.String("expected", "", "independent expected task/executor/grant/lease/fence JSON")
	keysPath := flags.String("keys", "", "caller-controlled public-key trust registry JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *stream {
		if flags.NArg() != 0 || *keysPath == "" || *requestPath != "" || *resultPath != "" || *receiptPath != "" || *expectedPath != "" {
			return fmt.Errorf("usage: evidence-check --stream --keys FILE")
		}
		verifier, err := loadVerifier(*keysPath)
		if err != nil {
			return err
		}
		return runStream(input, output, verifier)
	}
	if flags.NArg() != 0 || *requestPath == "" || *resultPath == "" || *receiptPath == "" || *expectedPath == "" || *keysPath == "" {
		return fmt.Errorf("usage: evidence-check --request FILE --result FILE --receipt FILE --expected FILE --keys FILE")
	}
	var request effects.EffectRequest
	var result effects.EffectResult
	var receipt effects.EffectReceipt
	var expected evidence.ExpectedExecution
	for _, input := range []struct {
		path  string
		dst   any
		limit int64
	}{
		{*requestPath, &request, maxSmallEnvelopeBytes},
		{*resultPath, &result, evidence.MaxJSONBytes},
		{*receiptPath, &receipt, maxSmallEnvelopeBytes},
		{*expectedPath, &expected, maxSmallEnvelopeBytes},
	} {
		if err := readEnvelope(input.path, input.dst, input.limit); err != nil {
			return fmt.Errorf("read %s: %w", input.path, err)
		}
	}
	verifier, err := loadVerifier(*keysPath)
	if err != nil {
		return err
	}
	observation, err := verifier.Verify(request, result, receipt, expected)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(observation)
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "evidence-check: %v\n", err)
		os.Exit(1)
	}
}
