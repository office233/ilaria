package planapproval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

var (
	idPattern   = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func validHash(value string) bool {
	raw, err := hex.DecodeString(value)
	return err == nil && len(raw) == sha256.Size && hex.EncodeToString(raw) == value
}

func clonePlan(plan wire.EffectPlan) wire.EffectPlan {
	copy := plan
	copy.Effects = append([]string{}, plan.Effects...)
	copy.CapabilityBindings = make(map[string]string, len(plan.CapabilityBindings))
	for key, value := range plan.CapabilityBindings {
		copy.CapabilityBindings[key] = value
	}
	return copy
}

func cloneProposal(p Proposal) Proposal {
	return Proposal{Source: append([]byte(nil), p.Source...), Module: append([]byte(nil), p.Module...), Plan: clonePlan(p.Plan)}
}

func pin(id string, number uint64, p Proposal, limit int) (Proposal, Revision, error) {
	if !idPattern.MatchString(id) || number == 0 || len(p.Source) == 0 || len(p.Module) == 0 {
		return Proposal{}, Revision{}, fmt.Errorf("%w: proposal identity and source/module required", ErrInvalid)
	}
	if len(p.Source) > effects.MaxValueBytes || len(p.Module) > effects.MaxValueBytes ||
		len(p.Source)+len(p.Module) > limit {
		return Proposal{}, Revision{}, ErrLimit
	}
	if err := wire.ValidatePlan(p.Plan); err != nil {
		return Proposal{}, Revision{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	raw, err := json.Marshal(p.Plan)
	if err != nil {
		return Proposal{}, Revision{}, err
	}
	if len(raw)+len(p.Source)+len(p.Module) > limit {
		return Proposal{}, Revision{}, ErrLimit
	}
	if digest(p.Module) != p.Plan.ModuleHash {
		return Proposal{}, Revision{}, fmt.Errorf("%w: module bytes do not match canonical plan", ErrRevision)
	}
	revision := Revision{ProposalID: id, Number: number, PlanHash: digest(raw),
		SourceHash: digest(p.Source), ModuleHash: p.Plan.ModuleHash}
	return cloneProposal(p), revision, nil
}

func validateVerdict(verdict Verdict, revision Revision) error {
	if verdict.Revision != revision {
		return ErrRevision
	}
	if !validHash(verdict.EvidenceHash) {
		return fmt.Errorf("%w: bounded canonical evidence hash required", ErrVerification)
	}
	switch verdict.Decision {
	case controlkernel.VerificationPassed:
		if verdict.Code != "" {
			return fmt.Errorf("%w: passed review cannot carry rejection code", ErrVerification)
		}
	case controlkernel.VerificationFailed:
		if !codePattern.MatchString(verdict.Code) {
			return fmt.Errorf("%w: rejected review requires a bounded reason code", ErrVerification)
		}
	default:
		return fmt.Errorf("%w: canonical decision required", ErrVerification)
	}
	return nil
}
