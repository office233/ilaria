package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/synthesis"
)

type contractSynthFlags struct {
	path    string
	options synthesis.ContractOptions
}

func addContractSynthFlags(f *flag.FlagSet) *contractSynthFlags {
	c := &contractSynthFlags{options: synthesis.DefaultContractOptions()}
	f.StringVar(&c.path, "contract", "", "opt-in typed contract JSON; requires a version-1 string-valued synthesis spec")
	f.IntVar(&c.options.Verify.MaxCases, "cases", c.options.Verify.MaxCases, "contract verification cases per proposal")
	f.IntVar(&c.options.Verify.FuelPerCase, "steps", c.options.Verify.FuelPerCase, "contract verification instructions per case")
	f.IntVar(&c.options.Verify.TotalFuel, "total-steps", c.options.Verify.TotalFuel, "shared core instruction budget across all refinement rounds")
	f.IntVar(&c.options.TotalCases, "total-cases", c.options.TotalCases, "shared verification/training case budget")
	f.IntVar(&c.options.MaxRounds, "rounds", c.options.MaxRounds, "maximum contract refinement rounds")
	f.Int64Var(&c.options.Verify.Seed, "seed", c.options.Verify.Seed, "deterministic contract sampling seed")
	f.BoolVar(&c.options.AllowSampled, "allow-sampled", false, "explicitly allow tested, non-exhaustive evidence when publishing a candidate")
	return c
}

// contractSynthContext is replaceable in tests: a 1ns CLI timeout is not a
// reliable expiry on platforms whose monotonic clock advances in coarse ticks.
var contractSynthContext = context.WithTimeout

// The legacy synth path is unchanged. This opt-in path never calls a model and
// publishes only accepted, type-checked core source via exclusive creation.
func synthContractCommand(output, specPath string, timeout time.Duration, flags contractSynthFlags, out io.Writer) (err error) {
	emitted := false
	defer func() {
		if err == nil || emitted {
			return
		}
		var d *coreir.Diagnostic
		if !errors.As(err, &d) {
			d = &coreir.Diagnostic{Code: "invalid_input", Message: err.Error()}
		}
		writeErr := json.NewEncoder(out).Encode(struct {
			Version    int                `json:"version"`
			Status     string             `json:"status"`
			Diagnostic *coreir.Diagnostic `json:"diagnostic"`
		}{1, "error", d})
		if writeErr != nil {
			err = errors.Join(err, writeErr)
		}
	}()
	if output == "" || flags.path == "" || timeout <= 0 || timeout > time.Minute {
		return fmt.Errorf("contract synthesis requires new output, contract, and timeout in (0,60s]")
	}
	if _, err := os.Lstat(output); err == nil {
		return fmt.Errorf("output already exists: %s", output)
	} else if !os.IsNotExist(err) {
		return err
	}
	contractBytes, err := readModuleInput(flags.path, 65536)
	if err != nil {
		return err
	}
	contract, err := coreir.DecodeContract(contractBytes)
	if err != nil {
		return err
	}
	specBytes, err := readModuleInput(specPath, 65536)
	if err != nil {
		return err
	}
	spec, err := synthesis.DecodeContractSpec(specBytes)
	if err != nil {
		return err
	}
	flags.options.SourceName = output
	ctx, cancel := contractSynthContext(context.Background(), timeout)
	defer cancel()
	result, searchErr := synthesis.SynthesizeContract(ctx, contract, spec, flags.options)
	// CLI evidence hashes exact input bytes rather than JSON reserialization.
	result.ContractSHA256 = coreHash(contractBytes)
	result.SpecSHA256 = coreHash(specBytes)
	for i := range result.History {
		result.History[i].Verification.ContractSHA256 = result.ContractSHA256
	}
	if searchErr != nil {
		emitted = true
		return errors.Join(searchErr, json.NewEncoder(out).Encode(result))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if result.Source == "" || (result.Status != "exhaustive" && result.Status != "tested") {
		return fmt.Errorf("refusing to publish unaccepted source")
	}
	if err := writeNewModule(output, []byte(result.Source)); err != nil {
		return err
	}
	emitted = true
	// A stdout failure after publication does not remove valid source.
	return json.NewEncoder(out).Encode(struct {
		synthesis.ContractResult
		Output string `json:"output"`
	}{result, output})
}
