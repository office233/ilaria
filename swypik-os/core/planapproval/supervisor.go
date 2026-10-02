package planapproval

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"swypik-os/core/controlkernel"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
)

type EffectHandler func(context.Context, wire.EffectRequest) (supervisor.Evidence, error)

// GuestRunner is host code, not a model callback. It must launch only the exact
// verified module, validate terminal frames/process exit, enforce OS process
// limits, and stop its owned guest when ctx is cancelled. The existing CLI
// engine is not exported; this package does not duplicate it.
type GuestRunner interface {
	Run(context.Context, Execution, EffectHandler) (string, error)
}

// SupervisorPolicy supplies explicit host scopes, budgets, roots, credentials,
// signer and independent effect verifier. It must assign durable ledger/task/run
// identities consistently, never recycle them for a new guest launch, and
// provide an ExecutionPolicyHash. None of this authority comes from Proposal.
type SupervisorPolicy func(context.Context, Execution) (supervisor.Config, error)

type SupervisorExecutor struct {
	policy SupervisorPolicy
	guest  GuestRunner
}

// NewSupervisorExecutor creates a host-only execution adapter. Do not expose
// the adapter itself as a proposal/provider RPC: the authenticated entry point
// is Coordinator.Accept followed by Coordinator.Execute.
func NewSupervisorExecutor(policy SupervisorPolicy, guest GuestRunner) (*SupervisorExecutor, error) {
	if policy == nil || guest == nil {
		return nil, fmt.Errorf("%w: explicit host policy and guest runner required", ErrExecutionUnavailable)
	}
	return &SupervisorExecutor{policy: policy, guest: guest}, nil
}

func cloneExecution(execution Execution) Execution {
	execution.Proposal = cloneProposal(execution.Proposal)
	return execution
}

func (adapter *SupervisorExecutor) Execute(ctx context.Context, execution Execution) (result ExecutionResult, err error) {
	if adapter == nil || adapter.policy == nil || adapter.guest == nil {
		return result, ErrExecutionUnavailable
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	pinned, revision, err := pin(execution.Revision.ProposalID, execution.Revision.Number, execution.Proposal, DefaultLimits().MaxProposalBytes)
	if err != nil || revision != execution.Revision || execution.Approval.Revision != revision ||
		execution.Review.Verdict.Revision != revision || execution.Approval.ActorID == "" ||
		execution.Review.Verdict.Decision != controlkernel.VerificationPassed {
		return result, errors.Join(ErrRevision, err)
	}
	if err := validateVerdict(execution.Review.Verdict, revision); err != nil {
		return result, err
	}
	execution.Proposal = pinned
	config, err := adapter.policy(ctx, cloneExecution(execution))
	if err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := matchingPlan(config, pinned.Plan); err != nil {
		return result, err
	}
	s, err := supervisor.Open(config)
	if err != nil {
		return result, err
	}
	defer func() { err = errors.Join(err, s.Close()) }()
	if err := s.Start(ctx); err != nil {
		result.Status = s.Status()
		result.Started = result.Status.State != supervisor.StateReady
		return result, err
	}
	result.Started = true
	valueHash, guestErr := adapter.guest.Run(ctx, cloneExecution(execution), s.Handle)
	guestErr = errors.Join(guestErr, ctx.Err())
	if guestErr != nil {
		code := "guest_failed"
		if errors.Is(guestErr, context.DeadlineExceeded) {
			code = "guest_timeout"
		} else if errors.Is(guestErr, context.Canceled) {
			code = "guest_cancelled"
		}
		result.Status, err = s.Abort(context.WithoutCancel(ctx), code)
		return result, errors.Join(guestErr, err)
	}
	result.Status, err = s.Finish(ctx, valueHash)
	if err != nil {
		status, abortErr := s.Abort(context.WithoutCancel(ctx), "guest_terminal_rejected")
		result.Status = status
		err = errors.Join(err, abortErr)
	}
	return result, err
}

func matchingPlan(config supervisor.Config, reviewed wire.EffectPlan) error {
	if config.Continuation.Enabled {
		return fmt.Errorf("%w: this runner seam does not transport authenticated continuation checkpoints", ErrExecutionUnavailable)
	}
	if !validHash(config.ExecutionPolicyHash) || config.Plan.MaxReadBytes > 64<<20 ||
		config.Plan.FuelLimit < 1 || config.Plan.FuelLimit > supervisor.MaxContinuationFuel ||
		config.Plan.MaxEffectBytes > supervisor.MaxContinuationEffectBytes {
		return fmt.Errorf("%w: explicit bounded host execution policy required", ErrInvalid)
	}
	plan := wire.EffectPlan{ProtocolVersion: wire.Version, ModuleHash: config.Plan.ModuleHash, Entry: config.Plan.Entry,
		Effects: append([]string{}, config.Plan.Effects...), CapabilityBindings: make(map[string]string)}
	sort.Strings(plan.Effects)
	for _, binding := range config.Plan.Bindings {
		key := binding.Function + "/" + binding.Effect
		if _, exists := plan.CapabilityBindings[key]; exists {
			return fmt.Errorf("%w: duplicate host plan binding", ErrRevision)
		}
		plan.CapabilityBindings[key] = binding.Capability
	}
	if err := wire.ValidatePlan(plan); err != nil {
		return err
	}
	if plan.ModuleHash != reviewed.ModuleHash || plan.Entry != reviewed.Entry ||
		strings.Join(plan.Effects, "\x00") != strings.Join(reviewed.Effects, "\x00") ||
		len(plan.CapabilityBindings) != len(reviewed.CapabilityBindings) {
		return ErrRevision
	}
	for key, capability := range plan.CapabilityBindings {
		if capability != reviewed.CapabilityBindings[key] {
			return ErrRevision
		}
	}
	return nil
}
