package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

func coreHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// The core commands are opt-in. Existing run/build/web/STV2 execution and wire
// formats keep their original semantics. JSON never encodes an i64 as float64.
func coreCommand(kind string, args []string, out io.Writer) (err error) {
	emitted := false
	defer func() {
		if err == nil || emitted {
			return
		}
		d := compilerDiagnostic(err)
		writeErr := json.NewEncoder(out).Encode(struct {
			Version    int                `json:"version"`
			Status     string             `json:"status"`
			Diagnostic *coreir.Diagnostic `json:"diagnostic"`
		}{1, "error", d})
		if writeErr != nil {
			err = errors.Join(err, writeErr)
		}
	}()
	flags := flag.NewFlagSet(kind, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := "main"
	steps := 100000
	profile := "safe"
	output := ""
	contractPath := ""
	timeout := 5 * time.Second
	options := coreir.DefaultVerifyOptions()
	if kind != "verify" {
		flags.StringVar(&entry, "entry", "main", "selected pure function")
	}
	if kind == "ir" {
		flags.StringVar(&output, "o", "", "new core JSON file; stdout by default")
	} else {
		flags.IntVar(&steps, "steps", 100000, "host per-run core instruction bound")
		flags.DurationVar(&timeout, "timeout", 5*time.Second, "execution deadline, 1ms..60s")
		if kind == "core-run" || kind == "core-exec" {
			flags.StringVar(&profile, "profile", "safe", "embedded execution profile: safe, fast or turbo")
		}
	}
	if kind == "verify" {
		flags.StringVar(&contractPath, "contract", "", "contract JSON file")
		flags.IntVar(&options.MaxCases, "cases", options.MaxCases, "maximum distinct input cases")
		flags.IntVar(&options.TotalFuel, "total-steps", options.TotalFuel, "total host core instruction bound")
		flags.Int64Var(&options.Seed, "seed", options.Seed, "deterministic sampling seed")
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() < 1 || ((kind == "ir" || kind == "verify") && flags.NArg() != 1) {
		return fmt.Errorf("%s requires one input file; only core-run/core-exec accept input values", kind)
	}
	if steps < 1 || steps > coreir.MaxFuel || timeout < time.Millisecond || timeout > time.Minute {
		return fmt.Errorf("steps must be 1..1000000 and timeout 1ms..60s")
	}
	if profile != "safe" && profile != "fast" && profile != "turbo" {
		return fmt.Errorf("unknown embedded profile %q; expected safe, fast or turbo", profile)
	}
	var contract coreir.Contract
	var contractData []byte
	if kind == "verify" {
		if contractPath == "" {
			return fmt.Errorf("verify requires -contract file.json")
		}
		contractData, err = readModuleInput(contractPath, 65536)
		if err != nil {
			return err
		}
		contract, err = coreir.DecodeContract(contractData)
		if err != nil {
			return err
		}
		entry = contract.Entry
	}
	input, err := readModuleInput(flags.Arg(0), coreir.MaxBytes)
	if err != nil {
		return err
	}
	var m coreir.Module
	sourceHash := ""
	if kind == "core-exec" {
		m, err = coreir.Decode(input)
	} else {
		sourceHash = coreHash(input)
		var p *swyplang.Program
		p, err = swyplang.ParseCore(flags.Arg(0), string(input))
		if err == nil {
			m, err = p.CoreIR(entry)
		}
	}
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(m)
	if err != nil {
		return err
	}
	irHash := coreHash(canonical)
	if kind == "ir" {
		if output != "" {
			data, err := json.MarshalIndent(m, "", "  ")
			if err != nil {
				return err
			}
			data = append(data, '\n')
			if err := writeNewModule(output, data); err != nil {
				return err
			}
			emitted = true
			return json.NewEncoder(out).Encode(struct {
				Version      int    `json:"version"`
				Path         string `json:"path"`
				IRSHA256     string `json:"ir_sha256"`
				SourceSHA256 string `json:"source_sha256"`
			}{1, output, irHash, sourceHash})
		}
		emitted = true
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(m)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if kind == "verify" {
		options.FuelPerCase = steps
		report, err := coreir.Verify(ctx, e, contract, options)
		if err != nil {
			return err
		}
		report.SourceSHA256 = sourceHash
		report.IRSHA256 = irHash
		report.ContractSHA256 = coreHash(contractData)
		emitted = true
		if err := json.NewEncoder(out).Encode(report); err != nil {
			return err
		}
		if report.Status != "tested" && report.Status != "exhaustive" {
			return fmt.Errorf("verification %s: %s", report.Status, report.Reason)
		}
		return nil
	}
	params, _, err := e.Parameters(entry)
	if err != nil {
		return err
	}
	if flags.NArg()-1 != len(params) {
		return fmt.Errorf("entry %s expects %d typed arguments", entry, len(params))
	}
	values := make([]coreir.Value, len(params))
	for i, p := range params {
		values[i], err = coreir.ParseValue(p.Type, flags.Arg(i+1))
		if err != nil {
			return err
		}
	}
	var r coreir.RunResult
	if profile == "turbo" {
		r, err = e.RunTurbo(ctx, entry, values, steps)
	} else if profile == "fast" {
		r, err = e.RunFast(ctx, entry, values, steps)
	} else {
		r, err = e.Run(ctx, entry, values, steps)
	}
	if err != nil {
		return err
	}
	emitted = true
	return json.NewEncoder(out).Encode(struct {
		Version      int              `json:"version"`
		Status       string           `json:"status"`
		Profile      string           `json:"profile"`
		Entry        string           `json:"entry"`
		Result       coreir.RunResult `json:"result"`
		IRSHA256     string           `json:"ir_sha256"`
		SourceSHA256 string           `json:"source_sha256,omitempty"`
	}{1, "ok", profile, entry, r, irHash, sourceHash})
}
