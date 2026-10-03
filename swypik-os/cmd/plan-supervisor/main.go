// plan-supervisor is a host-authorized reference service. Its stdin is a trusted
// control channel; a guest has only the separate broker subprocess pipes.
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
	"math"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"

	"swypik-os/core/effects"
	"swypik-os/core/resource"
)

func validateLiteral(value literal) error {
	valid := false
	switch value.Type {
	case "i64":
		n, err := strconv.ParseInt(value.Value, 10, 64)
		valid = err == nil && strconv.FormatInt(n, 10) == value.Value
	case "u64":
		n, err := strconv.ParseUint(value.Value, 10, 64)
		valid = err == nil && strconv.FormatUint(n, 10) == value.Value
	case "f64":
		n, err := strconv.ParseFloat(value.Value, 64)
		valid = err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && strconv.FormatFloat(n, 'g', -1, 64) == value.Value
	case "ieee64":
		n, err := strconv.ParseFloat(value.Value, 64)
		valid = err == nil && strconv.FormatFloat(n, 'g', -1, 64) == value.Value
	case "void":
		valid = value.Value == ""
	case "bool":
		valid = value.Value == "true" || value.Value == "false"
	case "bytes":
		b, err := base64.StdEncoding.Strict().DecodeString(value.Value)
		valid = err == nil && len(b) <= effects.MaxValueBytes && base64.StdEncoding.EncodeToString(b) == value.Value
	}
	if !valid {
		return fmt.Errorf("invalid typed guest final value")
	}
	return nil
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := runCommand(ctx, os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runCommand(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("plan-supervisor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "explicit absolute host configuration file")
	planID := flags.String("plan-id", "", "execute one configured plan")
	recoverPlan := flags.Bool("recover", false, "reconcile one interrupted configured plan without replay")
	serve := flags.Bool("serve", false, "trusted JSONL run/status/signals/shutdown channel")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *configPath == "" || (*serve == (*planID != "")) || (*serve && *recoverPlan) || (*recoverPlan && *planID == "") {
		return fmt.Errorf("usage: plan-supervisor --config HOST.json (--plan-id ID [--recover] | --serve)")
	}
	config, policy, err := loadConfiguration(*configPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	e, err := openEngine(ctx, config, policy)
	if err != nil {
		return err
	}
	defer e.Close()
	encoder := json.NewEncoder(output)
	if !*serve {
		var report runReport
		if *recoverPlan {
			report = e.recover(ctx, *planID)
			if err := encoder.Encode(report); err != nil {
				return err
			}
			if report.ErrorCode != "" {
				return fmt.Errorf("recovery rejected: %s", report.ErrorCode)
			}
			return nil
		}
		err = e.governor.Run(ctx, func(runCtx context.Context) error {
			report = e.run(runCtx, *planID, false)
			if err := encoder.Encode(report); err != nil {
				return err
			}
			if report.ErrorCode != "" {
				return fmt.Errorf("plan rejected: %s", report.ErrorCode)
			}
			return nil
		})
		return err
	}
	return serveCommands(ctx, cancel, e, input, output)
}

type command struct {
	Op      string                   `json:"op"`
	PlanID  string                   `json:"plan_id,omitempty"`
	Signals *resource.RuntimeSignals `json:"signals,omitempty"`
}

func serveCommands(ctx context.Context, cancel context.CancelFunc, e *engine, input io.Reader, output io.Writer) error {
	var outputMu sync.Mutex
	write := func(value any) error {
		outputMu.Lock()
		defer outputMu.Unlock()
		return json.NewEncoder(output).Encode(value)
	}
	jobs := make(chan command, 8)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case job, ok := <-jobs:
				if !ok {
					return
				}
				if job.Op == "status" || job.Op == "recover" {
					var report runReport
					if job.Op == "status" {
						report = e.run(ctx, job.PlanID, true)
					} else {
						report = e.recover(ctx, job.PlanID)
					}
					if err := write(report); err != nil {
						cancel()
						return
					}
					continue
				}
				err := e.governor.Run(ctx, func(runCtx context.Context) error {
					report := e.run(runCtx, job.PlanID, false)
					if err := write(report); err != nil {
						cancel()
						return err
					}
					if report.ErrorCode != "" {
						return errors.New(report.ErrorCode)
					}
					return nil
				})
				if err != nil && ctx.Err() == nil && e.governor.AuditError() != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); close(jobs); <-workerDone }()
	if err := write(struct {
		ProtocolVersion uint64                    `json:"protocol_version"`
		Type            string                    `json:"type"`
		Budget          resource.BackgroundBudget `json:"budget"`
	}{1, "ready", e.governor.Budget()}); err != nil {
		return err
	}
	// The reader sleeps in the pipe; the control loop can still react to signals
	// or worker failures. Closing process-owned stdin releases the reader.
	frames := make(chan []byte, 1)
	readErrors := make(chan error, 1)
	if closer, ok := input.(io.Closer); ok {
		defer closer.Close()
	}
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), (64<<10)+1)
		for scanner.Scan() {
			frame := append([]byte(nil), scanner.Bytes()...)
			if len(frame) > 64<<10 {
				readErrors <- fmt.Errorf("control frame exceeds limit")
				return
			}
			select {
			case frames <- frame:
			case <-ctx.Done():
				return
			}
		}
		readErrors <- scanner.Err()
	}()
	for {
		var raw []byte
		select {
		case <-ctx.Done():
			return ctx.Err()
		case frame, ok := <-frames:
			if !ok {
				select {
				case err := <-readErrors:
					return err
				default:
					return nil
				}
			}
			raw = frame
		}
		var request command
		if err := effects.DecodeStrict(raw, &request); err != nil {
			return fmt.Errorf("invalid trusted control frame")
		}
		switch request.Op {
		case "shutdown":
			if request.PlanID != "" || request.Signals != nil {
				return fmt.Errorf("invalid shutdown frame")
			}
			return nil
		case "signals":
			if request.Signals == nil || request.PlanID != "" {
				return fmt.Errorf("signals require an explicit host signal snapshot")
			}
			e.governor.UpdateSignals(*request.Signals)
			if err := e.governor.AuditError(); err != nil {
				return err
			}
			if err := write(struct {
				Type   string                    `json:"type"`
				Budget resource.BackgroundBudget `json:"budget"`
			}{"budget", e.governor.Budget()}); err != nil {
				return err
			}
		case "run", "status", "recover":
			if request.PlanID == "" || request.Signals != nil {
				return fmt.Errorf("run/status/recover require a configured plan ID")
			}
			select {
			case jobs <- request:
			case <-ctx.Done():
				return ctx.Err()
			default:
				if err := write(struct {
					ErrorCode string `json:"error_code"`
				}{"queue_full"}); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unsupported trusted control operation")
		}
	}
}
