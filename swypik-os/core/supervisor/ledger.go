package supervisor

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
)

const ledgerStream = "supervisor"

const (
	eventCreated      = "plan.created"
	eventStarted      = "plan.started"
	eventIssued       = "request.issued"
	eventCommitted    = "request.committed"
	eventContinuation = "continuation.sealed"
	eventFinished     = "plan.finished"
	eventStopped      = "plan.stopped"
)

var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

type createdPayload struct {
	LedgerID     string `json:"ledger_id"`
	PlanHash     string `json:"plan_hash"`
	TaskID       string `json:"task_id"`
	RunID        string `json:"run_id"`
	MaxEffects   uint64 `json:"max_effects"`
	MaxReadBytes int64  `json:"max_read_bytes"`
	Plan         Plan   `json:"plan,omitempty"`
}

type issuedPayload struct {
	Sequence          uint64 `json:"sequence"`
	RequestID         string `json:"request_id"`
	RequestHash       string `json:"request_hash"`
	NodeID            string `json:"node_id"`
	GrantID           string `json:"grant_id"`
	ReservedReadBytes int64  `json:"reserved_read_bytes"`
}

type committedPayload struct {
	Sequence    uint64 `json:"sequence"`
	RequestHash string `json:"request_hash"`
	ResultHash  string `json:"result_hash"`
	ReceiptHash string `json:"receipt_hash"`
	IntentID    string `json:"intent_id"`
}

type continuationPayload struct {
	Sequence       uint64 `json:"sequence"`
	RecordHash     string `json:"record_hash"`
	CheckpointHash string `json:"checkpoint_hash"`
	EnvelopeHash   string `json:"envelope_hash"`
	StateHash      string `json:"state_hash"`
	KeyID          string `json:"key_id"`
	NodeID         string `json:"node_id"`
	AttemptID      string `json:"attempt_id"`
	LeaseID        string `json:"lease_id"`
	Fence          uint64 `json:"fence"`
	RequestHash    string `json:"request_hash"`
	ResultHash     string `json:"result_hash"`
	ReceiptHash    string `json:"receipt_hash"`
	IntentID       string `json:"intent_id"`
}

type finishedPayload struct {
	ValueHash string `json:"value_hash"`
}

type stoppedPayload struct {
	State string `json:"state"`
	Code  string `json:"code"`
}

type ledgerState struct {
	sequence      uint64
	created       createdPayload
	status        Snapshot
	issued        map[uint64]issuedPayload
	commits       map[uint64]committedPayload
	continuations map[uint64]continuationPayload
}

func newLedgerState() ledgerState {
	return ledgerState{issued: make(map[uint64]issuedPayload), commits: make(map[uint64]committedPayload), continuations: make(map[uint64]continuationPayload)}
}

func (state ledgerState) clone() ledgerState {
	copy := state
	copy.issued = make(map[uint64]issuedPayload, len(state.issued))
	copy.commits = make(map[uint64]committedPayload, len(state.commits))
	copy.continuations = make(map[uint64]continuationPayload, len(state.continuations))
	for sequence, issued := range state.issued {
		copy.issued[sequence] = issued
	}
	for sequence, committed := range state.commits {
		copy.commits[sequence] = committed
	}
	for sequence, continuation := range state.continuations {
		copy.continuations[sequence] = continuation
	}
	return copy
}

func (state *ledgerState) apply(event controlkernel.Event) error {
	if event.Stream != ledgerStream || event.Seq != state.sequence+1 {
		return fmt.Errorf("invalid supervisor ledger stream or sequence")
	}
	if state.sequence == 0 && event.Type != eventCreated {
		return fmt.Errorf("supervisor ledger must begin with plan ownership")
	}
	switch event.Type {
	case eventCreated:
		var payload createdPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		if state.sequence != 0 || !validHash(payload.PlanHash) || payload.LedgerID == "" || payload.TaskID == "" || payload.RunID == "" ||
			payload.MaxEffects < 1 || payload.MaxEffects > MaxPlanEffects || payload.MaxReadBytes < 0 {
			return fmt.Errorf("invalid durable supervisor ownership/budget")
		}
		if payload.Plan.RunID != "" && (payload.Plan.TaskID != payload.TaskID || payload.Plan.RunID != payload.RunID ||
			payload.Plan.MaxEffects != payload.MaxEffects || payload.Plan.MaxReadBytes != payload.MaxReadBytes || !validHash(payload.Plan.ModuleHash) ||
			payload.Plan.Deadline.IsZero()) {
			return fmt.Errorf("invalid serialized supervisor program identity")
		}
		state.created = payload
		state.status = Snapshot{PlanHash: payload.PlanHash, TaskID: payload.TaskID, RunID: payload.RunID, ModuleHash: payload.Plan.ModuleHash,
			State: StateReady}
		if !payload.Plan.Deadline.IsZero() {
			state.status.DeadlineUnixMS = payload.Plan.Deadline.UTC().UnixMilli()
		}
	case eventStarted:
		var payload struct{}
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		if state.status.State != StateReady {
			return fmt.Errorf("supervisor guest launch already reserved")
		}
		state.status.State = StateRunning
	case eventIssued:
		var payload issuedPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		if state.status.State != StateRunning || state.status.Issued != state.status.Committed || payload.Sequence != state.status.Issued+1 ||
			payload.Sequence > state.created.MaxEffects || payload.RequestID != state.created.RunID+":"+strconv.FormatUint(payload.Sequence, 10) ||
			!validHash(payload.RequestHash) || payload.NodeID != nodeID(state.created.PlanHash, payload.Sequence) || payload.GrantID != grantID(state.created.PlanHash, payload.Sequence) ||
			payload.ReservedReadBytes < 0 || payload.ReservedReadBytes > state.created.MaxReadBytes-state.status.ReservedReadBytes {
			return fmt.Errorf("invalid supervisor request/budget reservation")
		}
		state.issued[payload.Sequence] = payload
		state.status.Issued++
		state.status.ReservedReadBytes += payload.ReservedReadBytes
	case eventCommitted:
		var payload committedPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		issued, exists := state.issued[payload.Sequence]
		if state.status.State != StateRunning || !exists || payload.Sequence != state.status.Committed+1 || payload.Sequence != state.status.Issued ||
			payload.RequestHash != issued.RequestHash || !validHash(payload.ResultHash) || !validHash(payload.ReceiptHash) || payload.IntentID == "" {
			return fmt.Errorf("invalid supervisor durable commit evidence")
		}
		state.commits[payload.Sequence] = payload
		state.status.Committed++
	case eventContinuation:
		var payload continuationPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		committed, committedExists := state.commits[payload.Sequence]
		if state.status.State != StateRunning || !committedExists || payload.Sequence == 0 || payload.Sequence != state.status.Committed ||
			state.status.Issued != state.status.Committed || !validHash(payload.RecordHash) || !validHash(payload.CheckpointHash) || !validHash(payload.EnvelopeHash) || !validHash(payload.StateHash) ||
			payload.KeyID == "" || payload.NodeID == "" || payload.AttemptID == "" || payload.LeaseID == "" || payload.Fence == 0 || payload.IntentID == "" ||
			!validHash(payload.RequestHash) || !validHash(payload.ResultHash) || !validHash(payload.ReceiptHash) ||
			payload.RequestHash != committed.RequestHash || payload.ResultHash != committed.ResultHash || payload.ReceiptHash != committed.ReceiptHash || payload.IntentID != committed.IntentID {
			return fmt.Errorf("invalid authenticated continuation ledger binding")
		}
		if _, exists := state.continuations[payload.Sequence]; exists {
			return fmt.Errorf("duplicate authenticated continuation for effect sequence")
		}
		state.continuations[payload.Sequence] = payload
	case eventFinished:
		var payload finishedPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		if state.status.State != StateRunning || state.status.Issued != state.status.Committed || !validHash(payload.ValueHash) {
			return fmt.Errorf("supervisor cannot finish without all issued effects committed")
		}
		state.status.State, state.status.FinalValueHash = StateSucceeded, payload.ValueHash
	case eventStopped:
		var payload stoppedPayload
		if err := effects.DecodeStrict(event.Data, &payload); err != nil {
			return err
		}
		if (state.status.State != StateReady && state.status.State != StateRunning) ||
			(payload.State != StateFailed && payload.State != StateUncertain) || !codePattern.MatchString(payload.Code) {
			return fmt.Errorf("invalid supervisor terminal stop")
		}
		state.status.State, state.status.FailureCode = payload.State, payload.Code
	default:
		return fmt.Errorf("unknown supervisor ledger event %q", event.Type)
	}
	state.sequence = event.Seq
	return nil
}

func ledgerIdentity() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(random[:]), nil
}

func (s *Supervisor) appendLocked(kind string, payload any) error {
	if err := s.checkLocked(); err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	event := controlkernel.Event{Stream: ledgerStream, Seq: s.ledger.sequence + 1, Type: kind, At: s.config.Now().UTC(), Data: raw}
	trial := s.ledger.clone()
	if err := trial.apply(event); err != nil {
		return err
	}
	if _, err := s.store.Append(ledgerStream, s.ledger.sequence, event); err != nil {
		s.failed = err
		return err
	}
	s.ledger = trial
	return nil
}
