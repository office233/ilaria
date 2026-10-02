package planapproval

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
)

const (
	ledgerStream   = "planapproval"
	eventPolicy    = "approval.policy"
	eventRecord    = "approval.record"
	maxRecordBytes = 8 << 10
)

type policy struct {
	Version    int    `json:"version"`
	ApproverID string `json:"approver_id"`
	VerifierID string `json:"verifier_id"`
	Limits     Limits `json:"limits"`
}

func normalize(config Config) (Config, error) {
	if !filepath.IsAbs(config.JournalPath) || !idPattern.MatchString(config.ApproverID) ||
		!idPattern.MatchString(config.VerifierID) || config.ApproverID == config.VerifierID ||
		config.Authenticator == nil || config.Verifier == nil {
		return Config{}, fmt.Errorf("%w: absolute journal, distinct host identities, authenticator and verifier required", ErrInvalid)
	}
	if config.Limits == (Limits{}) {
		config.Limits = DefaultLimits()
	}
	l := config.Limits
	if l.MaxProposalBytes < 1 || l.MaxProposalBytes > effects.MaxMessageBytes ||
		l.MaxProposals < 1 || l.MaxProposals > 64 || l.MaxRevisions < 1 || l.MaxRevisions > 16 ||
		l.MaxHistory < 4*l.MaxRevisions+3 || l.MaxHistory > 128 ||
		l.MaxConcurrent < 1 || l.MaxConcurrent > 8 ||
		l.VerifyTimeout <= 0 || l.VerifyTimeout > 60*time.Second || l.ExecuteTimeout <= 0 || l.ExecuteTimeout > 60*time.Second {
		return Config{}, fmt.Errorf("%w: limits must be positive, bounded and reserve terminal history", ErrInvalid)
	}
	return config, nil
}

// Open uses the existing kernel journal for durable metadata only. Source,
// module, credentials and capability authority are never stored here.
func Open(config Config) (*Coordinator, error) {
	config, err := normalize(config)
	if err != nil {
		return nil, err
	}
	maxJournal := int64(config.Limits.MaxProposals*config.Limits.MaxHistory*(maxRecordBytes+1024) + maxRecordBytes)
	if info, err := os.Lstat(config.JournalPath); err == nil {
		if !info.Mode().IsRegular() || info.Size() > maxJournal {
			return nil, fmt.Errorf("%w: journal must be regular and within the configured history bound", ErrLimit)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	store, err := controlkernel.OpenEventStore(config.JournalPath)
	if err != nil {
		return nil, err
	}
	c := &Coordinator{config: config, store: store, entries: make(map[string]*entry)}
	ok := false
	defer func() {
		if !ok {
			_ = store.Close()
		}
	}()
	expectedPolicy := policy{Version: 1, ApproverID: config.ApproverID, VerifierID: config.VerifierID, Limits: config.Limits}
	for _, event := range store.Events() {
		if event.Stream != ledgerStream || event.Seq != c.sequence+1 {
			return nil, fmt.Errorf("%w: invalid approval stream", controlkernel.ErrCorruptJournal)
		}
		if c.sequence == 0 {
			var found policy
			if event.Type != eventPolicy {
				return nil, fmt.Errorf("%w: missing approval policy", controlkernel.ErrCorruptJournal)
			}
			if err := decodeMetadata(event.Data, &found); err != nil {
				return nil, err
			}
			if found != expectedPolicy {
				return nil, ErrPolicyChanged
			}
		} else {
			var record Record
			if event.Type != eventRecord {
				return nil, fmt.Errorf("%w: unknown approval event", controlkernel.ErrCorruptJournal)
			}
			if err := decodeMetadata(event.Data, &record); err != nil {
				return nil, err
			}
			if err := c.validateNext(record); err != nil {
				return nil, fmt.Errorf("%w: %w", controlkernel.ErrCorruptJournal, err)
			}
			c.apply(record)
		}
		c.sequence++
	}
	store.DisableEventRetention()
	if c.sequence == 0 {
		raw, err := json.Marshal(expectedPolicy)
		if err != nil {
			return nil, err
		}
		if _, err := store.Append(ledgerStream, 0, controlkernel.Event{Type: eventPolicy, Data: raw}); err != nil {
			return nil, err
		}
		c.sequence++
	}
	// A crash can interrupt a verifier or a reserved launch. No restored
	// approval rehydrates executable artifacts or automatically resumes a guest.
	for _, e := range c.entries {
		record := cloneRecord(e.record)
		switch record.State {
		case Verifying:
			record.State, record.Code = Failed, "verification_interrupted"
		case Running:
			record.State, record.Code = Uncertain, "execution_interrupted"
		default:
			continue
		}
		if err := c.append(record); err != nil {
			return nil, err
		}
	}
	ok = true
	return c, nil
}

func decodeMetadata(raw []byte, target any) error {
	if len(raw) > maxRecordBytes {
		return ErrLimit
	}
	if err := effects.DecodeStrict(raw, target); err != nil {
		return err
	}
	canonical, err := json.Marshal(target)
	if err != nil {
		return err
	}
	if !bytes.Equal(canonical, raw) {
		return fmt.Errorf("%w: noncanonical approval metadata", controlkernel.ErrCorruptJournal)
	}
	return nil
}

func cloneRecord(record Record) Record {
	if record.Review != nil {
		value := *record.Review
		record.Review = &value
	}
	if record.Approval != nil {
		value := *record.Approval
		record.Approval = &value
	}
	if record.Execution != nil {
		value := *record.Execution
		record.Execution = &value
	}
	return record
}

func (c *Coordinator) validateNext(next Record) error {
	r := next.Revision
	if !idPattern.MatchString(r.ProposalID) || r.Number < 1 || r.Number > uint64(c.config.Limits.MaxRevisions) ||
		!validHash(r.PlanHash) || !validHash(r.SourceHash) || !validHash(r.ModuleHash) ||
		next.Code != "" && !codePattern.MatchString(next.Code) {
		return ErrInvalid
	}
	if next.Review != nil {
		if err := validateVerdict(next.Review.Verdict, r); err != nil {
			return err
		}
		if next.Review.VerifierID != c.config.VerifierID {
			return ErrUnauthorized
		}
	}
	if next.Approval != nil && (next.Approval.Revision != r || next.Approval.ActorID != c.config.ApproverID ||
		next.Review == nil || next.Review.Verdict.Decision != controlkernel.VerificationPassed) {
		return ErrUnauthorized
	}
	if next.Attempted && next.Approval == nil || next.Execution != nil && !next.Attempted {
		return ErrInvalid
	}
	switch next.State {
	case Proposed, Verifying:
		if next.Review != nil || next.Approval != nil || next.Attempted || next.CancelRequested || next.Execution != nil || next.Code != "" {
			return ErrInvalid
		}
	case Verified:
		if next.Review == nil || next.Review.Verdict.Decision != controlkernel.VerificationPassed || next.Approval != nil ||
			next.Attempted || next.CancelRequested || next.Execution != nil || next.Code != "" {
			return ErrInvalid
		}
	case Approved:
		if next.Approval == nil || next.Attempted || next.CancelRequested || next.Execution != nil || next.Code != "" {
			return ErrInvalid
		}
	case Running:
		if !next.Attempted || next.Execution != nil || next.Code != "" {
			return ErrInvalid
		}
	case Rejected:
		if next.Review == nil || next.Review.Verdict.Decision != controlkernel.VerificationFailed || next.Approval != nil ||
			next.Attempted || next.CancelRequested || next.Execution != nil || next.Code != next.Review.Verdict.Code {
			return ErrInvalid
		}
	case Succeeded:
		if !next.Attempted || next.CancelRequested || next.Execution == nil || !next.Execution.Started || next.Code != "" ||
			next.Execution.Status.State != supervisor.StateSucceeded {
			return ErrInvalid
		}
	case Uncertain:
		if !next.Attempted || next.Code == "" {
			return ErrInvalid
		}
	case Failed:
		if next.Code == "" {
			return ErrInvalid
		}
		if next.Attempted && (next.Execution == nil ||
			next.Execution.Started && next.Execution.Status.State != supervisor.StateFailed) {
			return ErrInvalid
		}
	case Cancelled:
		if next.Code == "" || !next.CancelRequested {
			return ErrInvalid
		}
		if next.Attempted && (next.Execution == nil ||
			next.Execution.Started && next.Execution.Status.State != supervisor.StateFailed) {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	if next.Execution != nil {
		if err := validateExecution(*next.Execution, r); err != nil {
			return err
		}
	}
	old, exists := c.entries[r.ProposalID]
	if !exists {
		if len(c.entries) >= c.config.Limits.MaxProposals {
			return ErrLimit
		}
		if r.Number != 1 || next.State != Proposed {
			return ErrState
		}
		return nil
	}
	if len(old.history) >= c.config.Limits.MaxHistory {
		return ErrLimit
	}
	previous := old.record
	if r.Number != previous.Revision.Number {
		if r.Number != previous.Revision.Number+1 || !correctable(previous) || next.State != Proposed {
			return ErrState
		}
		return nil
	}
	if r != previous.Revision || previous.Attempted && !next.Attempted ||
		previous.CancelRequested && !next.CancelRequested {
		return ErrRevision
	}
	if previous.Review != nil && (next.Review == nil || *previous.Review != *next.Review) ||
		previous.Approval != nil && (next.Approval == nil || *previous.Approval != *next.Approval) {
		return ErrRevision
	}
	allowed := false
	switch previous.State {
	case Proposed:
		allowed = next.State == Verifying || next.State == Cancelled
	case Verifying:
		allowed = next.State == Verified || next.State == Rejected || next.State == Failed || next.State == Cancelled
	case Verified:
		allowed = next.State == Approved || next.State == Cancelled
	case Approved:
		allowed = next.State == Running || next.State == Cancelled
	case Rejected, Failed:
		allowed = !previous.Attempted && next.State == Cancelled
	case Running:
		allowed = next.State == Succeeded || next.State == Failed || next.State == Cancelled || next.State == Uncertain ||
			next.State == Running && !previous.CancelRequested && next.CancelRequested
	}
	if !allowed {
		return ErrState
	}
	return nil
}

func correctable(record Record) bool {
	return !record.Attempted && (record.State == Proposed || record.State == Verifying || record.State == Verified ||
		record.State == Approved || record.State == Rejected || record.State == Failed)
}

func (c *Coordinator) apply(record Record) {
	id := record.Revision.ProposalID
	e, exists := c.entries[id]
	if !exists {
		e = &entry{}
		c.entries[id] = e
	}
	e.record = cloneRecord(record)
	e.history = append(e.history, cloneRecord(record))
}

func (c *Coordinator) append(record Record) error {
	if err := c.check(); err != nil {
		return err
	}
	if err := c.validateNext(record); err != nil {
		return err
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(raw) > maxRecordBytes {
		return ErrLimit
	}
	if _, err := c.store.Append(ledgerStream, c.sequence, controlkernel.Event{Type: eventRecord, Data: raw}); err != nil {
		c.storageErr = err
		c.cancelAll()
		return err
	}
	c.sequence++
	c.apply(record)
	return nil
}
