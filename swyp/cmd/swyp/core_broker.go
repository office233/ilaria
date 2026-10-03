package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"time"
	"unicode/utf8"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
	continuationwire "swyp-lang/protocol/continuation"
	"swyp-lang/protocol/effects"
)

type coreBrokerCompletion struct {
	ProtocolVersion uint64             `json:"protocol_version"`
	Type            string             `json:"type"`
	RunID           string             `json:"run_id"`
	ModuleHash      string             `json:"module_hash"`
	Status          string             `json:"status"`
	Result          *coreir.Literal    `json:"result,omitempty"`
	Steps           int                `json:"steps"`
	Diagnostic      *coreir.Diagnostic `json:"diagnostic,omitempty"`
}

// coreBrokerCommand is an explicit safe-profile transport adapter. The only
// filesystem read it performs is the compiler input named by the caller. Guest
// effects travel over JSONL to a host that owns capability resolution.
func coreBrokerCommand(args []string, in io.Reader, out io.Writer) (err error) {
	completion := coreBrokerCompletion{ProtocolVersion: effects.Version, Type: "completion", Status: "failed"}
	encoder := json.NewEncoder(out)
	defer func() {
		if err != nil {
			completion.Diagnostic = compilerDiagnostic(err)
		}
		if writeErr := encoder.Encode(completion); writeErr != nil {
			err = errors.Join(err, writeErr)
		}
	}()
	flags := flag.NewFlagSet("core-broker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := "main"
	runID := ""
	fuel := 100000
	maxBytes := coreir.MaxByteArenaBytes
	timeout := 5 * time.Second
	inputIR := false
	continuations := false
	resume := false
	flags.StringVar(&runID, "run-id", "", "required host run identity; stable prefix for effect request IDs")
	flags.StringVar(&entry, "entry", "main", "selected Core function")
	flags.IntVar(&fuel, "steps", fuel, "exact safe Core instruction bound")
	flags.IntVar(&maxBytes, "max-bytes", maxBytes, "total bytes returned by broker in this run")
	flags.DurationVar(&timeout, "timeout", timeout, "execution and broker response deadline, 1ms..60s")
	flags.BoolVar(&inputIR, "ir", false, "consume a strict Core IR snapshot instead of compiling source")
	flags.BoolVar(&continuations, "continuations", false, "emit post-effect continuation checkpoints and require matching acknowledgements")
	flags.BoolVar(&resume, "resume", false, "read an authenticated continuation checkpoint as the first stdin frame and resume it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	completion.RunID = runID
	if runID == "" || flags.NArg() < 1 {
		return fmt.Errorf("core-broker requires --run-id and one input file followed by typed entry arguments")
	}
	if fuel < 1 || fuel > coreir.MaxFuel || maxBytes < 0 || maxBytes > coreir.MaxEffectBytes || timeout < time.Millisecond || timeout > time.Minute {
		return fmt.Errorf("steps must be 1..%d, max-bytes 0..%d and timeout 1ms..60s", coreir.MaxFuel, coreir.MaxEffectBytes)
	}
	if resume {
		continuations = true
	}
	input, err := readModuleInput(flags.Arg(0), coreir.MaxBytes)
	if err != nil {
		return err
	}
	var module coreir.Module
	if inputIR {
		module, err = coreir.Decode(input)
	} else {
		var program *swyplang.Program
		program, err = swyplang.ParseCore(flags.Arg(0), string(input))
		if err == nil {
			module, err = program.CoreIR(entry)
		}
	}
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(module)
	if err != nil {
		return err
	}
	completion.ModuleHash = coreHash(canonical)
	// Reserve enough suffix space for every possible sequence under the fuel
	// bound, so a late request cannot fail after an earlier effect succeeded.
	identity := effects.EffectRequest{
		ProtocolVersion: effects.Version, RequestID: runID + ":" + strconv.Itoa(coreir.MaxFuel),
		ModuleHash: completion.ModuleHash, Function: entry, Effect: "clock.read", Capability: "clock_read",
	}
	if err := effects.ValidateRequest(identity); err != nil {
		return &coreir.Diagnostic{Code: "invalid_run_id", Message: err.Error()}
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		return err
	}
	if executable.ModuleHash() != completion.ModuleHash {
		return &coreir.Diagnostic{Code: "invalid_module_identity", Message: "prepared module hash does not match broker canonical module hash"}
	}
	preflight, err := executable.PreflightEffects(entry)
	if err != nil {
		return err
	}
	if err := effects.ValidatePlan(effects.EffectPlan{
		ProtocolVersion: effects.Version, ModuleHash: completion.ModuleHash, Entry: preflight.Entry,
		Effects: preflight.Effects, CapabilityBindings: preflight.CapabilityBindings,
	}); err != nil {
		return &coreir.Diagnostic{Code: "invalid_effect_plan", Message: err.Error()}
	}
	var values []coreir.Value
	if resume {
		if flags.NArg() != 1 {
			return fmt.Errorf("--resume accepts no typed entry arguments; state is restored from the continuation")
		}
	} else {
		parameters, _, err := executable.Parameters(entry)
		if err != nil {
			return err
		}
		if flags.NArg()-1 != len(parameters) {
			return fmt.Errorf("entry %s expects %d typed arguments", entry, len(parameters))
		}
		values = make([]coreir.Value, len(parameters))
		for i, parameter := range parameters {
			values[i], err = coreir.ParseValue(parameter.Type, flags.Arg(i+1))
			if err != nil {
				return err
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	scanner := bufio.NewScanner(in)
	inputLimit := effects.MaxMessageBytes + 1
	if continuations {
		inputLimit = continuationwire.MaxMessageBytes + 1
	}
	scanner.Buffer(make([]byte, 64<<10), inputLimit)

	var imported *coreir.Continuation
	if resume {
		line, err := readCoreBrokerLine(ctx, scanner)
		if err != nil {
			return &coreir.Diagnostic{Code: "continuation_transport", Message: err.Error()}
		}
		checkpoint, err := continuationwire.DecodeCheckpoint(line)
		if err != nil {
			return &coreir.Diagnostic{Code: "invalid_continuation", Message: err.Error()}
		}
		if checkpoint.RunID != runID || checkpoint.ModuleHash != completion.ModuleHash || checkpoint.Entry != entry {
			return &coreir.Diagnostic{Code: "continuation_identity_mismatch", Message: "continuation checkpoint does not match run, module, or entry"}
		}
		if checkpoint.FuelLimit != uint64(fuel) || checkpoint.MaxEffectBytes != uint64(maxBytes) {
			return &coreir.Diagnostic{Code: "continuation_policy_changed", Message: "continuation checkpoint budgets do not match broker limits"}
		}
		state, err := coreir.DecodeContinuation(checkpoint.State)
		if err != nil {
			return err
		}
		if state.Version != checkpoint.StateVersion || state.RunID != checkpoint.RunID ||
			state.ModuleHash != checkpoint.ModuleHash || state.Entry != checkpoint.Entry ||
			state.FuelLimit != int(checkpoint.FuelLimit) || state.StepsUsed != int(checkpoint.StepsUsed) ||
			state.MaxEffectBytes != int(checkpoint.MaxEffectBytes) || state.EffectBytes != int(checkpoint.EffectBytes) ||
			state.EffectCursor != checkpoint.EffectCursor {
			return &coreir.Diagnostic{Code: "continuation_metadata_mismatch", Message: "wire checkpoint metadata does not match serialized Core state"}
		}
		imported = &state
	}

	var lastEffectCursor uint64
	var lastRequestHash, lastResultHash string
	handler := func(ctx context.Context, call coreir.EffectCall) (coreir.EffectReply, error) {
		if !utf8.Valid(call.Path) {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_path", Message: "fs.read path is not UTF-8"}
		}
		request := effects.EffectRequest{
			ProtocolVersion: effects.Version, RequestID: runID + ":" + strconv.FormatUint(call.Sequence, 10),
			ModuleHash: completion.ModuleHash, Function: call.Function, Effect: call.Effect,
			Capability: call.Requirement, Path: string(call.Path),
		}
		if err := effects.ValidateRequest(request); err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_request", Message: err.Error()}
		}
		if err := encoder.Encode(request); err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "effect_transport", Message: err.Error()}
		}
		line, err := readCoreBrokerLine(ctx, scanner)
		if err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "effect_transport", Message: err.Error()}
		}
		result, err := effects.DecodeResult(line)
		if err == nil {
			err = effects.ValidateResult(result, request)
		}
		if err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_result", Message: err.Error()}
		}
		if result.Status != "succeeded" {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "effect_" + result.Status, Message: result.ErrorCode}
		}
		requestHash, err := effects.RequestHash(request)
		if err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_request", Message: err.Error()}
		}
		resultHash, err := effects.ResultHash(result)
		if err != nil {
			return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_result", Message: err.Error()}
		}
		lastEffectCursor, lastRequestHash, lastResultHash = call.Sequence, requestHash, resultHash
		reply := coreir.EffectReply{Sequence: call.Sequence, Effect: call.Effect}
		if call.ResultType == coreir.U64 {
			// ValidateResult already establishes canonical nonnegative i64 Unix
			// milliseconds. Core clock.read retains its existing u64 type.
			value, err := strconv.ParseUint(string(result.Value), 10, 63)
			if err != nil {
				return coreir.EffectReply{}, &coreir.Diagnostic{Code: "invalid_effect_result", Message: err.Error()}
			}
			reply.Value = coreir.Uint(value)
		} else {
			reply.Bytes = result.Value
		}
		return reply, nil
	}

	options := coreir.EffectRunOptions{Fuel: fuel, MaxBytes: maxBytes, RunID: runID}
	if continuations {
		options.Checkpoint = func(ctx context.Context, state coreir.Continuation) error {
			if state.EffectCursor != lastEffectCursor || lastRequestHash == "" || lastResultHash == "" {
				return &coreir.Diagnostic{Code: "continuation_effect_mismatch", Message: "post-effect continuation is not correlated with the validated effect result"}
			}
			raw, err := coreir.EncodeContinuation(state)
			if err != nil {
				return err
			}
			stateHash, err := continuationwire.HashState(raw)
			if err != nil {
				return &coreir.Diagnostic{Code: "invalid_continuation", Message: err.Error()}
			}
			checkpoint := continuationwire.Checkpoint{
				ProtocolVersion: continuationwire.Version, Type: "continuation", StateVersion: state.Version,
				RunID: state.RunID, ModuleHash: state.ModuleHash, Entry: state.Entry,
				FuelLimit: uint64(state.FuelLimit), StepsUsed: uint64(state.StepsUsed),
				MaxEffectBytes: uint64(state.MaxEffectBytes), EffectBytes: uint64(state.EffectBytes),
				EffectCursor: state.EffectCursor, EffectRequestHash: lastRequestHash,
				EffectResultHash: lastResultHash, StateHash: stateHash, State: raw,
			}
			if err := continuationwire.ValidateCheckpoint(checkpoint); err != nil {
				return &coreir.Diagnostic{Code: "invalid_continuation", Message: err.Error()}
			}
			if err := encoder.Encode(checkpoint); err != nil {
				return &coreir.Diagnostic{Code: "continuation_transport", Message: err.Error()}
			}
			line, err := readCoreBrokerLine(ctx, scanner)
			if err != nil {
				return &coreir.Diagnostic{Code: "continuation_transport", Message: err.Error()}
			}
			ack, err := continuationwire.DecodeAck(line)
			if err == nil {
				err = continuationwire.ValidateAck(ack, checkpoint)
			}
			if err != nil {
				return &coreir.Diagnostic{Code: "invalid_continuation_ack", Message: err.Error()}
			}
			if ack.Status != "accepted" {
				return &coreir.Diagnostic{Code: "continuation_rejected", Message: ack.ErrorCode}
			}
			return nil
		}
	}
	var result coreir.EffectRunResult
	if imported != nil {
		result, err = executable.ResumeWithEffects(ctx, entry, *imported, options, handler)
	} else {
		result, err = executable.RunWithEffects(ctx, entry, values, options, handler)
	}
	completion.Steps = result.Steps
	if err != nil {
		return err
	}
	literal := result.Value.Literal()
	if result.Value.Type() == coreir.Bytes {
		bytes, err := result.ResolveBytes(result.Value)
		if err != nil {
			return err
		}
		literal.Value = base64.StdEncoding.EncodeToString(bytes)
	}
	completion.Result = &literal
	completion.Status = "succeeded"
	return nil
}

// A single outstanding read is allowed. If the deadline expires while stdin is
// blocked, the command returns and the CLI process exits. Embedding callers must
// close their reader after cancellation to release its pending read.
func readCoreBrokerLine(ctx context.Context, scanner *bufio.Scanner) ([]byte, error) {
	type scanned struct {
		line []byte
		err  error
	}
	ready := make(chan scanned, 1)
	go func() {
		if scanner.Scan() {
			ready <- scanned{line: append([]byte(nil), scanner.Bytes()...)}
			return
		}
		err := scanner.Err()
		if err == nil {
			err = io.EOF
		}
		ready <- scanned{err: err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-ready:
		return result.line, result.err
	}
}
