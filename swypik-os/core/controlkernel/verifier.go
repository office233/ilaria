package controlkernel

import "errors"

var ErrVerifierUnauthorized = errors.New("verifier authority rejected")
var ErrExecutorUnauthorized = errors.New("executor authority rejected")

// ExecutorPrincipal is the authenticated security identity bound to a lease.
// It is distinct from the caller-supplied worker/owner label used for display.
type ExecutorPrincipal struct {
	ID string
}

// ExecutorAuthenticator authenticates lease claimants before any execution
// epoch is minted. The opaque credential is never persisted.
type ExecutorAuthenticator interface {
	AuthenticateExecutor(credential string) (ExecutorPrincipal, error)
}

// VerifierPrincipal is an authenticated low-authority identity. It carries no
// executor lease or host capability.
type VerifierPrincipal struct {
	ID string
}

// VerifierAuthenticator is injected when the kernel is opened. The opaque
// credential is never persisted; only the authenticated principal ID is stored
// in the immutable verification event. Executor-controlled payload text cannot
// choose or forge verifier identity.
type VerifierAuthenticator interface {
	AuthenticateVerifier(credential string) (VerifierPrincipal, error)
}
