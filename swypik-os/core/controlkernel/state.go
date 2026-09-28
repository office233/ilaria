package controlkernel

import "fmt"

type NodeState string

const (
	NodePending          NodeState = "PENDING"
	NodeReady            NodeState = "READY"
	NodeLeased           NodeState = "LEASED"
	NodePreparing        NodeState = "PREPARING"
	NodeExecuting        NodeState = "EXECUTING"
	NodeVerifying        NodeState = "VERIFYING"
	NodeCommitting       NodeState = "COMMITTING"
	NodeSucceeded        NodeState = "SUCCEEDED"
	NodeRetryWait        NodeState = "RETRY_WAIT"
	NodeUncertain        NodeState = "UNCERTAIN"
	NodeReconciling      NodeState = "RECONCILING"
	NodeFailed           NodeState = "FAILED"
	NodeCancelled        NodeState = "CANCELLED"
	NodeBlocked          NodeState = "BLOCKED"
	NodeOperatorRequired NodeState = "OPERATOR_REQUIRED"
)

var normalTransitions = map[NodeState]map[NodeState]struct{}{
	NodePending: {
		NodeReady: {},
	},
	NodeReady: {
		NodeLeased: {},
	},
	NodeLeased: {
		NodePreparing: {},
		NodeRetryWait: {},
	},
	NodePreparing: {
		NodeExecuting: {},
		NodeRetryWait: {},
	},
	NodeExecuting: {
		NodeVerifying: {},
		NodeRetryWait: {},
		NodeUncertain: {},
	},
	NodeVerifying: {
		NodeCommitting: {},
		NodeRetryWait:  {},
		NodeUncertain:  {},
	},
	NodeCommitting: {
		NodeSucceeded: {},
		NodeUncertain: {},
	},
	NodeRetryWait: {
		NodeReady: {},
	},
	NodeUncertain: {
		NodeReconciling: {},
	},
	NodeReconciling: {
		NodeSucceeded:        {},
		NodeRetryWait:        {},
		NodeOperatorRequired: {},
		NodeFailed:           {},
	},
}

var terminalStates = map[NodeState]struct{}{
	NodeSucceeded:        {},
	NodeFailed:           {},
	NodeCancelled:        {},
	NodeBlocked:          {},
	NodeOperatorRequired: {},
}

// IsTerminal reports whether no further transition is allowed.
func IsTerminal(state NodeState) bool {
	_, ok := terminalStates[state]
	return ok
}

// CanTransition is the single transition policy used both before persistence
// and while replaying projections. FAILED/CANCELLED/BLOCKED are terminal exits
// available from every non-terminal state; OPERATOR_REQUIRED is reachable only
// through reconciliation because it represents an unresolved external effect.
func CanTransition(from, to NodeState) bool {
	if from == "" || to == "" || IsTerminal(from) {
		return false
	}
	if to == NodeFailed || to == NodeCancelled || to == NodeBlocked {
		return true
	}
	_, ok := normalTransitions[from][to]
	return ok
}

func validateTransition(from, to NodeState) error {
	if !CanTransition(from, to) {
		return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, from, to)
	}
	return nil
}

func validAttemptStatus(status AttemptStatus) bool {
	switch status {
	case AttemptPreparing, AttemptExecuting, AttemptVerifying, AttemptCommitting, AttemptSucceeded, AttemptFailed, AttemptUncertain:
		return true
	default:
		return false
	}
}

func canTransitionIntent(from, to IntentState) bool {
	switch from {
	case IntentPrepared:
		return to == IntentStarted || to == IntentAbandoned
	case IntentStarted:
		return to == IntentResult || to == IntentUncertain
	case IntentResult:
		return to == IntentCommitted || to == IntentReconciling
	case IntentUncertain:
		return to == IntentReconciling
	case IntentReconciling:
		return to == IntentCommitted
	default:
		return false
	}
}
