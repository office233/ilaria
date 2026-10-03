package plancache

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrMiss           = errors.New("plancache: miss")
	ErrCorrupt        = errors.New("plancache: corrupt entry")
	ErrUntrusted      = errors.New("plancache: host verification rejected snapshot")
	ErrConflict       = errors.New("plancache: immutable entry conflict")
	ErrQuota          = errors.New("plancache: quota exceeded")
	ErrLimit          = errors.New("plancache: configured size limit exceeded")
	ErrUnsafePath     = errors.New("plancache: unsafe cache path")
	ErrPolicyMismatch = errors.New("plancache: cache partition policy mismatch")
	ErrClosed         = errors.New("plancache: cache is closed")
)

// Snapshot contains opaque verified canonical Core IR plus the host-defined
// provenance and attestation bytes which establish why that IR may be trusted.
// plancache never interprets Core IR and never supplies signing authority.
type Snapshot struct {
	CanonicalIR []byte
	Provenance  []byte
	Attestation []byte
}

// Claim is passed to the host verifier on both Put and Get. CanonicalIRHash is
// computed by plancache over the exact CanonicalIR bytes. The verifier is
// responsible for validating provenance/attestation and for establishing that
// the digest refers to canonical, verified Core IR under the requested identity.
type Claim struct {
	Identity        Identity
	StoragePolicy   string
	CanonicalIRHash string
	IRBytes         int64
	Provenance      []byte
	Attestation     []byte
}

// Verifier is explicit host authority. Implementations may use public test
// keys, hardware/service trust, or another host policy, but plancache has no
// ambient verifier and contains no production key material.
type Verifier interface {
	VerifySnapshot(context.Context, Claim) error
}

type VerifierFunc func(context.Context, Claim) error

func (f VerifierFunc) VerifySnapshot(ctx context.Context, claim Claim) error {
	return f(ctx, claim)
}

func verifyWithHost(ctx context.Context, verifier Verifier, claim Claim) error {
	if verifier == nil {
		return fmt.Errorf("%w: verifier is required", ErrUntrusted)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := verifier.VerifySnapshot(ctx, claim); err != nil {
		return fmt.Errorf("%w: %v", ErrUntrusted, err)
	}
	return nil
}
