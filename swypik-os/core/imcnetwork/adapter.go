// Package imcnetwork is the OS-owned verified-round boundary. It contains no
// model, optimizer, tensor validation or ambient Ilaria authority.
package imcnetwork

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"swypik-os/core/controlkernel"
	"swypik-os/core/federated"
	"swypik-os/core/resource"
	"swypik-os/generated/myriad"
	"swypik-os/internal/planprocess"
	"time"
)

type IssuedRound struct {
	Expert, Session, Round, Genesis, CurrentParent, Recipe, Fixture, Purpose string
	Sequence, ConsentEpoch, Fence                                            uint64
	DeadlineUnixMS                                                           int64
	Contract                                                                 json.RawMessage
}

type NodeConfig struct {
	Resume                bool                                                                     `json:"resume"`
	Execute               func(context.Context, IssuedRound, RoundRunner) (VerifiedReceipt, error) `json:"-"`
	ID                    string                                                                   `json:"id"`
	Endpoint              string                                                                   `json:"endpoint"`
	RemoteID              string                                                                   `json:"remote_id"`
	State                 string                                                                   `json:"state"`
	Python                string                                                                   `json:"python"`
	Peer                  string                                                                   `json:"peer"`
	Library               string                                                                   `json:"public_library_root"`
	IssuerPublic          string                                                                   `json:"issuer_public"`
	EvaluatorPublic       string                                                                   `json:"evaluator_public"`
	Members               []Pin                                                                    `json:"members"`
	Rounds                int                                                                      `json:"rounds"`
	CPU                   uint32                                                                   `json:"cpu_percent"`
	Memory                uint64                                                                   `json:"memory_bytes"`
	Traffic               uint64                                                                   `json:"traffic_bytes"`
	TimeoutSeconds        int                                                                      `json:"timeout_seconds"`
	ConsentPollMS         int                                                                      `json:"consent_poll_ms,omitempty"`
	SyntheticPhaseProbe   bool                                                                     `json:"synthetic_phase_probe,omitempty"`
	SyntheticPhaseHoldMS  int                                                                      `json:"synthetic_phase_hold_ms,omitempty"`
	LearningRate          float64                                                                  `json:"learning_rate"`
	Steps                 int                                                                      `json:"steps"`
	RollbackAtEnd         bool                                                                     `json:"rollback_at_end"`
	RequireBatteryThermal bool                                                                     `json:"require_battery_thermal"`
	LinuxDelegatedRoot    string                                                                   `json:"linux_delegated_root,omitempty"`
}

// workerLimits maps the admitted network budget onto the OS process group of the
// IMC worker. On Linux the operator must delegate a cgroup v2 root (strict limits);
// on Windows a Job Object enforces the same CPU/memory/process ceilings.
func workerLimits(config NodeConfig) planprocess.Limits {
	return planprocess.Limits{CPUPercent: config.CPU, MemoryBytes: config.Memory, MaxProcesses: 1, LinuxDelegatedRoot: config.LinuxDelegatedRoot}
}

type Pin struct{ ID, Endpoint, Public, Role string }
type networkProgress struct {
	Session  string `json:"session"`
	Genesis  string `json:"genesis"`
	Parent   string `json:"parent"`
	Lineage  string `json:"lineage"`
	Sequence uint64 `json:"sequence"`
}

type networkPublication struct {
	Before    networkProgress        `json:"before"`
	After     networkProgress        `json:"after"`
	IntentKey string                 `json:"intent_key"`
	Kind      string                 `json:"kind,omitempty"`
	Rollback  *networkRollbackNotice `json:"rollback,omitempty"`
}

type networkProgressSync struct {
	Progress  networkProgress        `json:"progress"`
	Signature string                 `json:"signature"`
	Rollback  *networkRollbackNotice `json:"rollback,omitempty"`
}

// Rollback is a separate OS publication operation, never another training delta.
// Its signed certificate selects one already-committed immutable ancestor.
type networkRollbackCertificate struct {
	ProtocolVersion   uint64          `json:"protocol_version"`
	Operation         string          `json:"operation"`
	Before            networkProgress `json:"before"`
	After             networkProgress `json:"after"`
	Target            networkProgress `json:"target"`
	TargetIntentKey   string          `json:"target_intent_key"`
	RollbackIntentKey string          `json:"rollback_intent_key"`
	Nonce             string          `json:"nonce"`
	ConsentEpoch      uint64          `json:"consent_epoch"`
	LeaseFence        uint64          `json:"lease_fence"`
	DeadlineUnixMS    int64           `json:"deadline_unix_ms"`
}

type networkRollbackNotice struct {
	Certificate networkRollbackCertificate `json:"certificate"`
	Signature   string                     `json:"signature"`
}

type networkRollbackAck struct {
	Operation       string          `json:"operation"`
	Progress        networkProgress `json:"progress"`
	CertificateHash string          `json:"certificate_hash"`
}

type networkPilotMode struct {
	ProtocolVersion uint64 `json:"protocol_version"`
	Operation       string `json:"operation"`
	Rounds          int    `json:"rounds"`
	Resume          bool   `json:"resume"`
	RollbackAtEnd   bool   `json:"rollback_at_end"`
}

func validatePilotMode(config NodeConfig, mode networkPilotMode) error {
	if mode.ProtocolVersion != 1 || mode.Operation != "pilot-mode" || mode.Rounds != config.Rounds || mode.Resume != config.Resume || mode.RollbackAtEnd != config.RollbackAtEnd {
		return errors.New("peer bounded pilot mode mismatch")
	}
	return nil
}

func agreePilotMode(ctx context.Context, session *federated.SocketSession, config NodeConfig) error {
	if err := consent(config.State); err != nil {
		return err
	}
	mode := networkPilotMode{ProtocolVersion: 1, Operation: "pilot-mode", Rounds: config.Rounds, Resume: config.Resume, RollbackAtEnd: config.RollbackAtEnd}
	if err := session.Send(ctx, encode(mode)); err != nil {
		return err
	}
	raw, err := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
	if err != nil {
		return err
	}
	var remote networkPilotMode
	if err = decodeContract(raw, &remote); err != nil {
		return err
	}
	return validatePilotMode(config, remote)
}

func sequenceRound(sequence uint64) string { return fmt.Sprintf("round-%d", sequence) }

func rollbackLineage(before networkProgress, target networkProgress, targetKey string, sequence uint64) string {
	return hash(canonicalJSON(map[string]any{"operation": "rollback-v1", "prior_lineage": before.Lineage, "target_parent": target.Parent, "target_intent_key": targetKey, "sequence": sequence}))
}

func immutableMetadata(directory, name string, value any) error {
	return immutableBytes(directory, name, encode(value))
}

func immutableBytes(directory, name string, data []byte) error {
	path := filepath.Join(directory, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(err) {
		previous, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(previous, data) {
			return errors.New("immutable network metadata conflict")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func progressHistory(directory string, progress networkProgress) error {
	if err := validateProgress(progress); err != nil {
		return err
	}
	return immutableMetadata(directory, fmt.Sprintf("history-%d.json", progress.Sequence), progress)
}

func readProgressHistory(directory string, sequence uint64) (networkProgress, error) {
	var progress networkProgress
	raw, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("history-%d.json", sequence)))
	if err != nil {
		return progress, err
	}
	if err = decodeContract(raw, &progress); err != nil {
		return progress, err
	}
	if err = validateProgress(progress); err != nil {
		return progress, err
	}
	if progress.Sequence != sequence || !bytes.Equal(raw, encode(progress)) {
		return progress, errors.New("network ancestor history integrity")
	}
	return progress, nil
}

func committedProgress(directory string, progress networkProgress) error {
	if err := validateProgress(progress); err != nil {
		return err
	}
	if progress.Sequence == 0 {
		return errors.New("genesis is not a committed publication event")
	}
	return immutableMetadata(directory, fmt.Sprintf("committed-%d.json", progress.Sequence), progress)
}

func readCommittedProgress(directory string, sequence uint64) (networkProgress, error) {
	var progress networkProgress
	raw, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("committed-%d.json", sequence)))
	if err != nil {
		return progress, err
	}
	if err = decodeContract(raw, &progress); err != nil {
		return progress, err
	}
	if err = validateProgress(progress); err != nil {
		return progress, err
	}
	if sequence == 0 || progress.Sequence != sequence || !bytes.Equal(raw, encode(progress)) {
		return progress, errors.New("committed ancestor metadata integrity")
	}
	return progress, nil
}

// Checkpoint bytes may recur after rollback. Select the latest committed event
// for the prior checkpoint at or before its exact sequence cutoff, never by
// filesystem order or by treating content-addressed bytes as an event identity.
func findCommittedAncestor(directory string, prior networkProgress, kernel *controlkernel.Kernel) (networkProgress, error) {
	var selected networkProgress
	if err := validateProgress(prior); err != nil {
		return selected, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return selected, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "committed-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		sequence, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, "committed-"), ".json"), 10, 64)
		if err != nil || name != fmt.Sprintf("committed-%d.json", sequence) {
			return selected, errors.New("unversioned or invalid committed ancestor metadata")
		}
		if sequence > prior.Sequence {
			continue
		}
		progress, err := readCommittedProgress(directory, sequence)
		if err != nil {
			return selected, err
		}
		if progress.Session != prior.Session || progress.Genesis != prior.Genesis {
			return selected, errors.New("committed ancestor session/genesis mismatch")
		}
		if progress.Parent == prior.Parent && progress.Sequence > selected.Sequence {
			selected = progress
		}
	}
	if selected.Sequence == 0 {
		return selected, errors.New("prior checkpoint lacks a committed ancestor version")
	}
	if err := validateCommittedAncestor(directory, selected, kernel); err != nil {
		return selected, err
	}
	return selected, nil
}

func validateCommittedAncestor(directory string, target networkProgress, kernel *controlkernel.Kernel) error {
	if kernel == nil {
		return errors.New("committed ancestor requires authoritative journal")
	}
	intent, ok := kernel.IntentByKey(target.Session + sequenceRound(target.Sequence))
	if !ok || intent.State != controlkernel.IntentCommitted || intent.Kind != "synthetic-model-publication" || intent.NodeID != sequenceRound(target.Sequence) || intent.ExternalRef != target.Parent || !validCheckpointHash(intent.ResultHash) {
		return errors.New("rollback target lacks committed publication authority")
	}
	committed, err := readCommittedProgress(directory, target.Sequence)
	if err != nil || committed != target {
		return errors.New("rollback committed event metadata mismatch")
	}
	known, err := readProgressHistory(directory, target.Sequence)
	if err != nil || known != target {
		return errors.New("rollback committed event history mismatch")
	}
	before, err := readProgressHistory(directory, target.Sequence-1)
	if err != nil || before.Session != target.Session || before.Genesis != target.Genesis || intent.RequestHash != before.Parent || target.Lineage != hash([]byte(before.Lineage+target.Parent)) {
		return errors.New("rollback committed event preceding progress mismatch")
	}
	return nil
}

func validateRollbackNotice(notice networkRollbackNotice, issuer ed25519.PublicKey, now time.Time, live bool) error {
	c := notice.Certificate
	if len(issuer) != ed25519.PublicKeySize || !ed25519.Verify(issuer, encode(c), mustDecode(notice.Signature)) {
		return errors.New("rollback issuer-role signature")
	}
	for _, progress := range []networkProgress{c.Before, c.After, c.Target} {
		if err := validateProgress(progress); err != nil {
			return err
		}
	}
	if c.ProtocolVersion != 1 || c.Operation != "rollback" || c.Before.Sequence == ^uint64(0) || c.After.Sequence != c.Before.Sequence+1 || c.Target.Sequence == 0 || c.Target.Sequence >= c.Before.Sequence || c.Target.Parent == c.Before.Parent || c.After.Parent != c.Target.Parent || c.ConsentEpoch != 1 || c.LeaseFence == 0 || !validCheckpointHash(c.Nonce) || c.DeadlineUnixMS <= 0 {
		return errors.New("rollback operation/sequence/authority mismatch")
	}
	if c.Before.Session != c.After.Session || c.Before.Session != c.Target.Session || c.Before.Genesis != c.After.Genesis || c.Before.Genesis != c.Target.Genesis || c.TargetIntentKey != c.Before.Session+sequenceRound(c.Target.Sequence) || c.RollbackIntentKey != c.Before.Session+sequenceRound(c.After.Sequence) || c.After.Lineage != rollbackLineage(c.Before, c.Target, c.TargetIntentKey, c.After.Sequence) {
		return errors.New("rollback identity/ancestor/lineage mismatch")
	}
	if live && now.UnixMilli() >= c.DeadlineUnixMS {
		return errors.New("rollback deadline expired")
	}
	return nil
}

func validateRollbackAncestor(directory string, notice networkRollbackNotice, kernel *controlkernel.Kernel) error {
	c := notice.Certificate
	known, err := readProgressHistory(directory, c.Target.Sequence)
	if err != nil || known != c.Target {
		return errors.New("rollback target is not a known ancestor")
	}
	if kernel != nil {
		if err := validateCommittedAncestor(directory, c.Target, kernel); err != nil {
			return err
		}
		raw, err := os.ReadFile(filepath.Join(directory, c.Target.Parent+".json"))
		if err != nil || !json.Valid(raw) || hash(canonicalJSON(json.RawMessage(raw))) != c.Target.Parent {
			return errors.New("rollback immutable target integrity")
		}
	}
	return nil
}

func rollbackMetadata(directory string, notice networkRollbackNotice) error {
	return immutableMetadata(directory, fmt.Sprintf("rollback-%d.json", notice.Certificate.After.Sequence), notice)
}

// Resume may finish the metadata transaction after an interrupted ACK. Durable
// reservations still prevent redispatch; repairing progress never trains a model.
func admitPeerRollback(directory string, current networkProgress, notice networkRollbackNotice, issuer ed25519.PublicKey, resume bool, reservationLimit int) (networkProgress, error) {
	c := notice.Certificate
	if err := validateRollbackNotice(notice, issuer, time.Now(), !resume); err != nil {
		return current, err
	}
	if current != c.Before && !(resume && current == c.After) {
		return current, errors.New("rollback peer exact preceding progress mismatch")
	}
	if err := validateRollbackAncestor(directory, notice, nil); err != nil {
		return current, err
	}
	if err := consent(directory); err != nil {
		return current, err
	}
	// Each marker is immutable; an exact certificate permits completing a partial
	// metadata reservation after a crash, never rerunning a worker operation.
	entries, err := os.ReadDir(directory)
	if err != nil {
		return current, err
	}
	count := 0
	for _, entry := range entries {
		if len(entry.Name()) > 5 && entry.Name()[:5] == "used-" {
			count++
		}
	}
	identities := []string{c.Before.Session + sequenceRound(c.After.Sequence), c.Before.Session + c.Nonce}
	previousNotice, noticeErr := os.ReadFile(filepath.Join(directory, fmt.Sprintf("rollback-%d.json", c.After.Sequence)))
	if noticeErr != nil && !os.IsNotExist(noticeErr) {
		return current, noticeErr
	}
	storedCertificate := noticeErr == nil && bytes.Equal(previousNotice, encode(notice))
	if noticeErr == nil && !storedCertificate {
		return current, errors.New("immutable rollback certificate conflict")
	}
	missing := 0
	for _, identity := range identities {
		raw, readErr := os.ReadFile(filepath.Join(directory, "used-"+hash([]byte(identity))))
		if readErr == nil {
			if !storedCertificate || string(raw) != "reserved" {
				return current, errors.New("rollback conflicts with preceding work reservation")
			}
		} else if os.IsNotExist(readErr) {
			missing++
		} else {
			return current, readErr
		}
	}
	if count > reservationLimit-missing {
		return current, errors.New("worker durable work bound")
	}
	if err := rollbackMetadata(directory, notice); err != nil {
		return current, err
	}
	for _, identity := range identities {
		path := filepath.Join(directory, "used-"+hash([]byte(identity)))
		if raw, readErr := os.ReadFile(path); readErr == nil {
			if string(raw) != "reserved" {
				return current, errors.New("rollback reservation integrity")
			}
			continue
		} else if !os.IsNotExist(readErr) {
			return current, readErr
		}
		if count >= reservationLimit {
			return current, errors.New("worker durable work bound")
		}
		if err := immutableBytes(directory, filepath.Base(path), []byte("reserved")); err != nil {
			return current, err
		}
		count++
	}
	if err := progressHistory(directory, c.After); err != nil {
		return current, err
	}
	if err := consent(directory); err != nil {
		return current, err
	}
	if err := save(filepath.Join(directory, "progress.json"), encode(c.After)); err != nil {
		return current, err
	}
	return c.After, nil
}

func committedRollback(directory string, progress networkProgress, kernel *controlkernel.Kernel, issuer ed25519.PublicKey) (*networkRollbackNotice, error) {
	raw, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("rollback-%d.json", progress.Sequence)))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var notice networkRollbackNotice
	if err = decodeContract(raw, &notice); err != nil {
		return nil, err
	}
	if !bytes.Equal(raw, encode(notice)) {
		return nil, errors.New("rollback record canonical integrity")
	}
	if err = validateRollbackNotice(notice, issuer, time.Time{}, false); err != nil {
		return nil, err
	}
	if notice.Certificate.After != progress {
		return nil, errors.New("rollback record/current progress mismatch")
	}
	if err = validateRollbackAncestor(directory, notice, kernel); err != nil {
		return nil, err
	}
	intent, ok := kernel.IntentByKey(notice.Certificate.RollbackIntentKey)
	if !ok || intent.State != controlkernel.IntentCommitted || intent.Kind != "synthetic-model-rollback" || intent.NodeID != sequenceRound(progress.Sequence) || intent.RequestHash != hash(encode(notice.Certificate)) || intent.ExternalRef != progress.Parent || intent.ResultHash != hash(raw) || intent.Fence != notice.Certificate.LeaseFence {
		return nil, errors.New("rollback record lacks exact committed journal evidence")
	}
	return &notice, nil
}

// publishRollback uses the same kernel intent/verification/CAS publication path
// as training adoption. The target is existing committed state, not a new delta.
func publishRollback(ctx context.Context, directory string, kernel *controlkernel.Kernel, credential string, token controlkernel.LeaseToken, intent controlkernel.Intent, notice networkRollbackNotice, issuer ed25519.PublicKey) error {
	c := notice.Certificate
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRollbackNotice(notice, issuer, time.Now(), true); err != nil {
		return err
	}
	if err := validateRollbackAncestor(directory, notice, kernel); err != nil {
		return err
	}
	if intent.Kind != "synthetic-model-rollback" || intent.NodeID != sequenceRound(c.After.Sequence) || intent.IdempotencyKey != c.RollbackIntentKey || intent.RequestHash != hash(encode(c)) || token.Fence != c.LeaseFence {
		return errors.New("rollback publication intent/lease binding mismatch")
	}
	beforeRaw, err := os.ReadFile(filepath.Join(directory, "progress.json"))
	if err != nil || !bytes.Equal(beforeRaw, encode(c.Before)) {
		return errors.New("rollback preceding progress CAS failed")
	}
	active, err := os.ReadFile(filepath.Join(directory, "active.json"))
	if err != nil || string(active) != c.Before.Parent {
		return errors.New("rollback active current-parent CAS failed")
	}
	if err = consent(directory); err != nil {
		return err
	}
	if _, err = kernel.ValidateExecutorLease(credential, "network-issuer", intent.NodeID, token); err != nil {
		return err
	}
	pending := networkPublication{Before: c.Before, After: c.After, IntentKey: c.RollbackIntentKey, Kind: "synthetic-model-rollback", Rollback: &notice}
	if err = save(filepath.Join(directory, "pending.json"), encode(pending)); err != nil {
		return err
	}
	defer func() { _ = ReconcileNetworkPublication(directory, kernel, issuer) }()
	if _, err = kernel.StartIntent(intent.ID, token); err != nil {
		return err
	}
	if err = rollbackMetadata(directory, notice); err != nil {
		return err
	}
	evidence := hash(encode(notice))
	if _, err = kernel.RecordIntentResult(intent.ID, token, c.After.Parent, evidence); err != nil {
		return err
	}
	if err = kernel.TransitionNode(intent.NodeID, controlkernel.NodeVerifying, token); err != nil {
		return err
	}
	// The independent verifier checks restoration policy/lineage and committed
	// ancestor integrity. This is not a fresh model quality evaluation.
	if err = validateRollbackAncestor(directory, notice, kernel); err != nil {
		return err
	}
	if _, err = kernel.RecordVerification("pinned-independent-evaluator", controlkernel.VerificationRequest{NodeID: intent.NodeID, Decision: controlkernel.VerificationPassed, EvidenceHash: evidence, ExpectedVerifierID: "network-evaluator"}); err != nil {
		return err
	}
	if err = kernel.TransitionNode(intent.NodeID, controlkernel.NodeCommitting, token); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = consent(directory); err != nil {
		return err
	}
	if err = validateRollbackNotice(notice, issuer, time.Now(), true); err != nil {
		return err
	}
	if _, err = kernel.ValidateExecutorLease(credential, "network-issuer", intent.NodeID, token); err != nil {
		return err
	}
	if err = save(filepath.Join(directory, "active.json"), []byte(c.After.Parent)); err != nil {
		return err
	}
	if _, err = kernel.CommitIntent(intent.ID, token); err != nil {
		return err
	}
	if err = progressHistory(directory, c.After); err != nil {
		return err
	}
	if err = save(filepath.Join(directory, "progress.json"), encode(c.After)); err != nil {
		return err
	}
	if err = kernel.TransitionNode(intent.NodeID, controlkernel.NodeSucceeded, token); err != nil {
		return err
	}
	return os.Remove(filepath.Join(directory, "pending.json"))
}

func acceptResumeProgress(directory string, current, next networkProgress) error {
	if err := validateProgress(current); err != nil {
		return err
	}
	if err := validateProgress(next); err != nil {
		return err
	}
	if next.Session != current.Session || next.Genesis != current.Genesis {
		return errors.New("resume peer identity mismatch")
	}
	if next.Sequence == current.Sequence {
		if next != current {
			return errors.New("resume peer same-sequence conflict")
		}
		return nil
	}
	if current.Sequence == ^uint64(0) || next.Sequence != current.Sequence+1 {
		return errors.New("resume peer sequence jump")
	}
	round := fmt.Sprintf("round-%d", next.Sequence)
	if _, err := os.Stat(filepath.Join(directory, "used-"+hash([]byte(next.Session+round)))); err != nil {
		return errors.New("resume peer lacks preceding round reservation")
	}
	if next.Parent == current.Parent {
		if next.Lineage != current.Lineage {
			return errors.New("resume peer rejected lineage mismatch")
		}
	} else if next.Lineage != hash([]byte(current.Lineage+next.Parent)) {
		return errors.New("resume peer accepted lineage mismatch")
	}
	if err := progressHistory(directory, next); err != nil {
		return err
	}
	return save(filepath.Join(directory, "progress.json"), encode(next))
}

func validCheckpointHash(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && len(value) == 64
}

func validateProgress(progress networkProgress) error {
	if progress.Session == "" || !validCheckpointHash(progress.Genesis) || !validCheckpointHash(progress.Parent) || !validCheckpointHash(progress.Lineage) {
		return errors.New("invalid network progress identity")
	}
	return nil
}

// Progress is durable before the peer observes the next parent. Lost ACKs never
// justify retraining/reapplying the preceding logical round.
func persistAndAckIssuerProgress(directory string, progress networkProgress, send func([]byte) error) error {
	if err := validateProgress(progress); err != nil {
		return err
	}
	if err := progressHistory(directory, progress); err != nil {
		return err
	}
	if err := save(filepath.Join(directory, "progress.json"), encode(progress)); err != nil {
		return err
	}
	return send(encode(progress))
}

// loadIssuerProgress selects the current parent without changing the immutable genesis.
func loadIssuerProgress(directory string, resume bool, genesis json.RawMessage, genesisHash string) (networkProgress, json.RawMessage, error) {
	progress := networkProgress{Session: hash([]byte(directory)), Genesis: genesisHash, Parent: genesisHash, Lineage: genesisHash}
	if !resume {
		return progress, genesis, nil
	}
	data, err := os.ReadFile(filepath.Join(directory, "progress.json"))
	if err != nil {
		return progress, nil, err
	}
	if err = json.Unmarshal(data, &progress); err != nil {
		return progress, nil, err
	}
	if progress.Genesis != genesisHash {
		return progress, nil, errors.New("resume genesis mismatch")
	}
	if err := validateProgress(progress); err != nil {
		return progress, nil, err
	}
	decoded, err := hex.DecodeString(progress.Parent)
	if err != nil || len(decoded) != sha256.Size {
		return progress, nil, errors.New("resume parent integrity")
	}
	parent, err := os.ReadFile(filepath.Join(directory, progress.Parent+".json"))
	if err != nil || hash(canonicalJSON(json.RawMessage(parent))) != progress.Parent {
		return progress, nil, errors.New("resume parent integrity")
	}
	if active, err := os.ReadFile(filepath.Join(directory, "active.json")); err == nil && string(active) != progress.Parent {
		return progress, nil, errors.New("resume active/progress mismatch; rollback continuation unresolved")
	} else if err != nil && !os.IsNotExist(err) {
		return progress, nil, err
	}
	return progress, parent, nil
}

func persistInitialCheckpoints(directory, genesisHash string, genesis, parent json.RawMessage, parentHash string) error {
	if !json.Valid(genesis) || !json.Valid(parent) {
		return errors.New("initial checkpoint JSON integrity")
	}
	genesisBytes, parentBytes := canonicalJSON(genesis), canonicalJSON(parent)
	if hash(genesisBytes) != genesisHash || hash(parentBytes) != parentHash {
		return errors.New("initial checkpoint hash integrity")
	}
	// Preserve both content-addressed objects before publishing the selected parent.
	// A resumed parent must never be written under the genesis hash.
	if _, err := Checkpoint(directory, json.RawMessage(genesisBytes)); err != nil {
		return err
	}
	if _, err := Checkpoint(directory, json.RawMessage(parentBytes)); err != nil {
		return err
	}
	return save(filepath.Join(directory, "active.json"), []byte(parentHash))
}

type NodeSecrets struct {
	Transport string `json:"transport_private"`
	Role      string `json:"role_private"`
	Evaluator string `json:"evaluator_private"`
}
type networkRequest struct {
	Operation  string               `json:"operation"`
	SignedJob  string               `json:"signed_job"`
	Signature  string               `json:"signature"`
	Pins       map[string]string    `json:"pins"`
	Parent     json.RawMessage      `json:"parent"`
	Candidate  json.RawMessage      `json:"candidate,omitempty"`
	Recipe     json.RawMessage      `json:"recipe,omitempty"`
	PhaseProbe *syntheticPhaseProbe `json:"phase_probe,omitempty"`
}

// SyntheticPhaseProbe is local diagnostic authority, never part of model policy.
// The fixed own-state marker permits one bounded observation after a real step.
type syntheticPhaseProbe struct {
	Path   string `json:"path"`
	HoldMS int    `json:"hold_ms"`
}

func checkedSyntheticPhaseProbe(config NodeConfig) (*syntheticPhaseProbe, error) {
	if !config.SyntheticPhaseProbe {
		if config.SyntheticPhaseHoldMS != 0 {
			return nil, errors.New("synthetic phase hold requires diagnostic opt-in")
		}
		return nil, nil
	}
	if config.ID != "proposer" || config.Resume || config.SyntheticPhaseHoldMS < 0 || config.SyntheticPhaseHoldMS > 1000 || !filepath.IsAbs(config.State) {
		return nil, errors.New("synthetic phase probe requires fresh proposer own-state and hold0..1000ms")
	}
	if err := consent(config.State); err != nil {
		return nil, err
	}
	clean := filepath.Clean(config.State)
	for path := clean; ; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("synthetic phase probe state symlink or invalid directory")
		}
		if filepath.Dir(path) == path {
			break
		}
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || !strings.EqualFold(resolved, clean) {
		return nil, errors.New("synthetic phase probe state alias")
	}
	path := filepath.Join(clean, "synthetic-phase.json")
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return nil, errors.New("synthetic phase probe marker already exists or inaccessible")
	}
	return &syntheticPhaseProbe{Path: path, HoldMS: config.SyntheticPhaseHoldMS}, nil
}

type networkResponse struct {
	Candidate json.RawMessage `json:"candidate"`
	Signature string          `json:"signature"`
	PID       int             `json:"os_pid"`
	WorkerPID any             `json:"worker_pid"`
}

func hash(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func encode(v any) []byte    { b, _ := json.Marshal(v); return b }
func canonicalJSON(v any) []byte {
	raw := encode(v)
	var m any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&m)
	return encode(m)
}
func decodeContract(raw []byte, out any) error {
	if len(raw) > federated.PilotFrameBytes {
		return errors.New("contract frame cap")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(out); e != nil {
		return e
	}
	if e := decoder.Decode(new(any)); e != io.EOF {
		return errors.New("trailing contract JSON")
	}
	return nil
}
func validateLiveJob(raw []byte, signature string, pinned ed25519.PublicKey) error {
	var job myriad.IMCNetworkRoundJob
	if e := decodeContract(raw, &job); e != nil {
		return e
	}
	if job.ProtocolVersion != 2 || job.RoundSequence == 0 || job.ConsentEpoch == 0 || job.LeaseFence == 0 || job.DeadlineUnixMS <= time.Now().UnixMilli() || job.IssuerID != "issuer" || job.ExpertID != "synthetic-imc" || job.ProposerID != "proposer" || job.EvaluatorID != "evaluator" || job.DatasetScope != "synthetic-public-v1" || job.AuthorizedPurpose != "local-network-training" || job.RecipeJSON == "" {
		return errors.New("generated job authority/freshness")
	}
	if !bytes.Equal(canonicalJSON(job), raw) || !ed25519.Verify(pinned, raw, mustDecode(signature)) {
		return errors.New("canonical pinned generated job")
	}
	for _, value := range []string{job.SessionID, job.RoundID, job.GenesisCheckpointHash, job.CurrentParentCheckpointHash, job.LineageHash, job.ModelConfigHash, job.CurriculumManifestHash, job.TrainingRecipeHash, job.ProposerKeyHash, job.EvaluatorKeyHash, job.Nonce} {
		if value == "" {
			return errors.New("incomplete generated job")
		}
	}
	return nil
}
func save(path string, data []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".publish-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	c := f.Close()
	if e != nil {
		return e
	}
	if c != nil {
		return c
	}
	return os.Rename(name, path)
}

// Shared own-state publication used by local-v1 and network orchestration.
func AtomicFile(path string, data []byte) error { return save(path, data) }
func Checkpoint(directory string, value any) (string, error) {
	data, e := json.Marshal(value)
	if e != nil {
		return "", e
	}
	id := hash(data)
	path := filepath.Join(directory, id+".json")
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(e) {
		old, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(old, data) {
			return "", errors.New("immutable checkpoint mismatch")
		}
		return id, nil
	}
	if e != nil {
		return "", e
	}
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return "", e
	}
	return id, closeErr
}
func RecoverPointer(directory string) error {
	path := filepath.Join(directory, "pending.json")
	data, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var pending map[string]string
	if e = json.Unmarshal(data, &pending); e != nil {
		return e
	}
	base := pending["base"]
	if len(base) != 64 {
		return errors.New("invalid recovery base")
	}
	raw, e := os.ReadFile(filepath.Join(directory, base+".json"))
	if e != nil || hash(raw) != base {
		return errors.New("recovery checkpoint integrity")
	}
	if e = save(filepath.Join(directory, "active.json"), []byte(base)); e != nil {
		return e
	}
	return os.Remove(path)
}

// ReconcileNetworkPublication distinguishes a committed journal intent from an
// uncertain write. Never apply a delta again during crash recovery.
func ReconcileNetworkPublication(directory string, kernel *controlkernel.Kernel, issuer ...ed25519.PublicKey) error {
	path := filepath.Join(directory, "pending.json")
	data, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e = json.Unmarshal(data, &fields); e != nil {
		return e
	}
	if _, typed := fields["before"]; typed {
		var pending networkPublication
		if e = json.Unmarshal(data, &pending); e != nil {
			return e
		}
		if e = validateProgress(pending.Before); e != nil {
			return e
		}
		if e = validateProgress(pending.After); e != nil {
			return e
		}
		round := fmt.Sprintf("round-%d", pending.After.Sequence)
		kind, requestHash := "synthetic-model-publication", pending.Before.Parent
		if pending.Kind == "synthetic-model-rollback" {
			if pending.Rollback == nil || len(issuer) != 1 {
				return errors.New("rollback recovery requires pinned issuer certificate")
			}
			if e = validateRollbackNotice(*pending.Rollback, issuer[0], time.Time{}, false); e != nil {
				return e
			}
			c := pending.Rollback.Certificate
			if c.Before != pending.Before || c.After != pending.After || c.RollbackIntentKey != pending.IntentKey {
				return errors.New("rollback recovery certificate binding mismatch")
			}
			if e = validateRollbackAncestor(directory, *pending.Rollback, kernel); e != nil {
				return e
			}
			kind, requestHash = pending.Kind, hash(encode(c))
		} else if pending.Kind != "" || pending.Rollback != nil {
			return errors.New("unknown publication operation")
		} else if pending.After.Lineage != hash([]byte(pending.Before.Lineage+pending.After.Parent)) {
			return errors.New("publication lineage mismatch")
		}
		if pending.Before.Sequence == ^uint64(0) || pending.After.Sequence != pending.Before.Sequence+1 || pending.After.Session != pending.Before.Session || pending.After.Genesis != pending.Before.Genesis || pending.IntentKey != pending.After.Session+round {
			return errors.New("publication progress binding mismatch")
		}
		intent, exists := kernel.IntentByKey(pending.IntentKey)
		if !exists || intent.Kind != kind || intent.NodeID != round || intent.RequestHash != requestHash {
			return errors.New("publication lacks matching authoritative intent")
		}
		target := pending.Before
		committed := intent.State == controlkernel.IntentCommitted
		if committed {
			if intent.ExternalRef != pending.After.Parent || !validCheckpointHash(intent.ResultHash) {
				return errors.New("committed publication result binding mismatch")
			}
			if pending.Rollback != nil && (intent.ResultHash != hash(encode(*pending.Rollback)) || intent.Fence != pending.Rollback.Certificate.LeaseFence) {
				return errors.New("committed rollback certificate evidence mismatch")
			}
			target = pending.After
		}
		raw, err := os.ReadFile(filepath.Join(directory, target.Parent+".json"))
		if err != nil || !json.Valid(raw) || hash(canonicalJSON(json.RawMessage(raw))) != target.Parent {
			return errors.New("publication recovery checkpoint mismatch")
		}
		if err = save(filepath.Join(directory, "active.json"), []byte(target.Parent)); err != nil {
			return err
		}
		if err = save(filepath.Join(directory, "progress.json"), encode(target)); err != nil {
			return err
		}
		if !committed {
			return errors.New("publication outcome unresolved; prior parent restored without redispatch")
		}
		if pending.Rollback != nil {
			if err = rollbackMetadata(directory, *pending.Rollback); err != nil {
				return err
			}
		} else {
			if err = committedProgress(directory, target); err != nil {
				return err
			}
		}
		if err = progressHistory(directory, target); err != nil {
			return err
		}
		return os.Remove(path)
	}
	var pending map[string]string
	if e = json.Unmarshal(data, &pending); e != nil {
		return e
	}
	target := pending["base"]
	if intent, ok := kernel.IntentByKey(pending["intent_key"]); ok && intent.State == controlkernel.IntentCommitted {
		if intent.Kind != "synthetic-model-publication" || intent.RequestHash != pending["base"] || intent.ExternalRef != pending["candidate"] || !validCheckpointHash(intent.ResultHash) {
			return errors.New("legacy committed publication requires verified journal bindings or migration")
		}
		target = pending["candidate"]
	}
	if !validCheckpointHash(pending["base"]) || !validCheckpointHash(pending["candidate"]) || !validCheckpointHash(target) {
		return errors.New("invalid publication recovery hash")
	}
	data, e = os.ReadFile(filepath.Join(directory, target+".json"))
	if e != nil || hash(data) != target {
		return errors.New("publication recovery checkpoint mismatch")
	}
	if e = save(filepath.Join(directory, "active.json"), []byte(target)); e != nil {
		return e
	}
	return os.Remove(path)
}
func call(ctx context.Context, p *planprocess.Process, request any) (map[string]json.RawMessage, error) {
	if e := p.SendJSON(ctx, request); e != nil {
		return nil, fmt.Errorf("worker write %v; %v", e, p.Wait(ctx))
	}
	line, e := p.ReadLine(ctx)
	if e != nil {
		return nil, fmt.Errorf("worker read %v; %v", e, p.Wait(ctx))
	}
	var response map[string]json.RawMessage
	if e = json.Unmarshal(line, &response); e != nil {
		return nil, e
	}
	if raw, ok := response["error"]; ok {
		return nil, fmt.Errorf("worker refusal %s", raw)
	}
	return response, nil
}

func consent(state string) error {
	data, e := os.ReadFile(filepath.Join(state, "consent.json"))
	if e != nil {
		return e
	}
	var c struct {
		OptIn   bool   `json:"opt_in"`
		Epoch   int    `json:"epoch"`
		Scope   string `json:"scope"`
		Purpose string `json:"purpose"`
	}
	if e = json.Unmarshal(data, &c); e != nil {
		return e
	}
	if !c.OptIn || c.Epoch != 1 || c.Scope != "synthetic-public-v1" || c.Purpose != "local-network-training" {
		return errors.New("participation/data consent revoked")
	}
	return nil
}

// The default keeps existing configs active while giving consent revocation a
// short polling bound. A caller cannot disable monitoring with zero or a large
// interval. Filesystem and scheduler latency remain outside a real-time claim.
func checkedConsentPoll(milliseconds int) (time.Duration, error) {
	if milliseconds == 0 {
		milliseconds = 100
	}
	if milliseconds < 10 || milliseconds > 1000 {
		return 0, errors.New("consent poll interval outside10..1000ms")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

// One linked context owns the node's socket waits and existing worker Job.
// Every return cancels and joins the monitor; admission/effect checks remain
// necessary because polling does not make consent and publication atomic.
func withConsentMonitor(parent context.Context, state string, interval time.Duration, run func(context.Context) error) error {
	if parent == nil || run == nil || interval < 10*time.Millisecond || interval > time.Second {
		return errors.New("consent monitor requires context, callback and bounded interval")
	}
	if err := parent.Err(); err != nil {
		return context.Cause(parent)
	}
	if err := consent(state); err != nil {
		return err
	}
	ctx, cancel := context.WithCancelCause(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := consent(state); err != nil {
					cancel(fmt.Errorf("participation consent canceled: %w", err))
					return
				}
			}
		}
	}()
	defer func() {
		cancel(nil)
		<-done
	}()
	err := run(ctx)
	finished := errors.New("consent monitor scope finished")
	cancel(finished)
	<-done
	if cause := context.Cause(ctx); cause != finished {
		return errors.Join(cause, err)
	}
	if err != nil {
		return err
	}
	return consent(state)
}

type nodeGroupCloser interface{ Close() error }

// Bind only after the sole Group.Start completes: closing the group must not
// race its platform activation. Termination is then independent of an executor
// returning from a canceled wait. Normal and cancellation cleanup share one
// cached Close outcome; a failed termination must never become a successful join.
func closeNodeGroupOnCancel(ctx context.Context, group nodeGroupCloser) func() error {
	done := make(chan struct{})
	var closeErr error
	stop := context.AfterFunc(ctx, func() {
		defer close(done)
		closeErr = group.Close()
	})
	return func() error {
		if stop() {
			closeErr = group.Close()
			close(done)
		} else {
			<-done
		}
		return closeErr
	}
}

// Recheck admission after a potentially blocking network wait. Revocation
// during the wait must not dispatch a new worker command.
func receiveWithConsent(state string, receive func() ([]byte, error)) ([]byte, error) {
	if err := consent(state); err != nil {
		return nil, err
	}
	raw, err := receive()
	if err != nil {
		return nil, err
	}
	if err = consent(state); err != nil {
		return nil, err
	}
	return raw, nil
}

func validatePilotMembership(config NodeConfig) error {
	if len(config.Members) != 2 {
		return errors.New("pilot requires exactly issuer and proposer")
	}
	expected := map[string]string{"issuer": "issuer", "proposer": "worker"}
	seen := map[string]bool{}
	for _, pin := range config.Members {
		role, ok := expected[pin.ID]
		if !ok || seen[pin.ID] || pin.Role != role {
			return errors.New("pilot membership identity/role mismatch")
		}
		seen[pin.ID] = true
	}
	if (config.ID != "issuer" && config.ID != "proposer") || config.RemoteID == config.ID || !seen[config.RemoteID] {
		return errors.New("pilot counterpart identity mismatch")
	}
	return nil
}

func validateCounterpart(config NodeConfig, peer federated.BootstrapMember) error {
	if err := validatePilotMembership(config); err != nil {
		return err
	}
	for _, pin := range config.Members {
		if pin.ID == config.RemoteID {
			public, err := hex.DecodeString(pin.Public)
			if err != nil || len(public) != ed25519.PublicKeySize || peer.ID != pin.ID || peer.Role != pin.Role || peer.Endpoint != pin.Endpoint || !bytes.Equal(peer.PublicKey, public) {
				return errors.New("authenticated pilot counterpart mismatch")
			}
			return nil
		}
	}
	return errors.New("pilot counterpart absent")
}

func validateIssuerAck(issued myriad.IMCNetworkRoundJob, raw []byte, issuer ed25519.PublicKey) (networkProgress, error) {
	var ack networkProgressSync
	if err := decodeContract(raw, &ack); err != nil {
		return networkProgress{}, err
	}
	if len(issuer) != ed25519.PublicKeySize || !ed25519.Verify(issuer, encode(ack.Progress), mustDecode(ack.Signature)) {
		return networkProgress{}, errors.New("issuer progress acknowledgment signature")
	}
	next := ack.Progress
	if err := validateProgress(next); err != nil {
		return networkProgress{}, err
	}
	if next.Sequence != issued.RoundSequence || next.Session != issued.SessionID || next.Genesis != issued.GenesisCheckpointHash {
		return networkProgress{}, errors.New("issuer progress acknowledgment identity mismatch")
	}
	lineage := issued.LineageHash
	if next.Parent != issued.CurrentParentCheckpointHash {
		lineage = hash([]byte(lineage + next.Parent))
	}
	if next.Lineage != lineage {
		return networkProgress{}, errors.New("issuer progress acknowledgment lineage mismatch")
	}
	return next, nil
}

type RoundBounds struct{ Jobs, Reservations, WorkerCommands int }

func CheckedRoundBounds(rounds int, rollback bool) (RoundBounds, error) {
	if rounds < 2 || rounds > 8 {
		return RoundBounds{}, errors.New("round count outside2..8")
	}
	jobs := rounds + 1
	commands := 2 + jobs
	reservations := jobs * 2
	if rollback {
		commands++
		reservations += 2
	}
	return RoundBounds{Jobs: jobs, Reservations: reservations, WorkerCommands: commands}, nil
}
func reserveWork(directory string, jobJSON string) error {
	return reserveWorkBounded(directory, jobJSON, 18)
}
func reserveWorkBounded(directory string, jobJSON string, limit int) error {
	var job map[string]any
	if e := json.Unmarshal([]byte(jobJSON), &job); e != nil {
		return e
	}
	entries, e := os.ReadDir(directory)
	if e != nil {
		return e
	}
	count := 0
	for _, entry := range entries {
		if len(entry.Name()) > 5 && entry.Name()[:5] == "used-" {
			count++
		}
	}
	if count+2 > limit {
		return errors.New("worker durable work bound")
	}
	for _, identity := range []string{fmt.Sprint(job["session_id"], job["round_id"]), fmt.Sprint(job["session_id"], job["nonce"])} {
		f, e := os.OpenFile(filepath.Join(directory, "used-"+hash([]byte(identity))), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return errors.New("worker durable round/nonce replay")
		}
		_, e = f.Write([]byte("reserved"))
		if e == nil {
			e = f.Sync()
		}
		c := f.Close()
		if e != nil {
			return e
		}
		if c != nil {
			return c
		}
	}
	return nil
}

type nodeAuth string

func (a nodeAuth) AuthenticateExecutor(c string) (controlkernel.ExecutorPrincipal, error) {
	if c != string(a) {
		return controlkernel.ExecutorPrincipal{}, fmt.Errorf("unauthorized")
	}
	return controlkernel.ExecutorPrincipal{ID: "network-issuer"}, nil
}
func (a nodeAuth) AuthenticateVerifier(c string) (controlkernel.VerifierPrincipal, error) {
	if c != "pinned-independent-evaluator" {
		return controlkernel.VerifierPrincipal{}, fmt.Errorf("unauthorized verifier")
	}
	return controlkernel.VerifierPrincipal{ID: "network-evaluator"}, nil
}

func RunNode(ctx context.Context, config NodeConfig, secrets NodeSecrets) error {
	interval, err := checkedConsentPoll(config.ConsentPollMS)
	if err != nil {
		return err
	}
	if _, err := checkedSyntheticPhaseProbe(config); err != nil {
		return err
	}
	return withConsentMonitor(ctx, config.State, interval, func(nodeCtx context.Context) error {
		return runNode(nodeCtx, config, secrets)
	})
}

func runNode(ctx context.Context, config NodeConfig, secrets NodeSecrets) (resultErr error) {
	phaseProbe, phaseErr := checkedSyntheticPhaseProbe(config)
	if phaseErr != nil {
		return phaseErr
	}
	if err := validatePilotMembership(config); err != nil {
		return err
	}
	bounds, e := CheckedRoundBounds(config.Rounds, config.RollbackAtEnd)
	if e != nil {
		return e
	}
	if config.Rounds < 2 || config.Rounds > 8 || config.CPU < 1 || config.CPU > 100 || config.Memory == 0 || config.TimeoutSeconds < 1 || config.TimeoutSeconds > 120 {
		return errors.New("explicit bounded node config required")
	}
	issuerKey, e := hex.DecodeString(config.IssuerPublic)
	if e != nil || len(issuerKey) != 32 {
		return errors.New("pinned issuer key")
	}
	if e := consent(config.State); e != nil {
		return e
	}
	if config.RequireBatteryThermal {
		return errors.New("required battery/thermal signals unavailable in this CPU loopback pilot; refused")
	}
	// Restart admission happens before sockets or model allocation. Journal
	// recovery may select an already-written immutable checkpoint, never retrain.
	if config.ID == "issuer" {
		journal := filepath.Join(config.State, "authority.journal")
		if _, err := os.Stat(journal); err == nil {
			k, err := controlkernel.OpenKernel(journal)
			if err != nil {
				return err
			}
			if err = ReconcileNetworkPublication(config.State, k, issuerKey); err != nil {
				k.Close()
				return err
			}
			if _, err := os.Stat(filepath.Join(config.State, "progress.json")); err == nil && !config.Resume {
				k.Close()
				return errors.New("restart replay denied before worker allocation")
			}
			k.Close()
		}
	}
	hostSampler, e := resource.NewProcessSampler(os.Getpid())
	if e != nil {
		return e
	}
	defer hostSampler.Close()
	hostBefore, e := hostSampler.Sample()
	if e != nil {
		return e
	}
	idleTimer := time.NewTimer(100 * time.Millisecond)
	defer idleTimer.Stop()
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-idleTimer.C:
	}
	hostIdle, e := hostSampler.Sample()
	if e != nil {
		return e
	}
	transportKey, e := hex.DecodeString(secrets.Transport)
	if e != nil || len(transportKey) != 64 {
		return errors.New("ephemeral transport key")
	}
	roleKey, e := hex.DecodeString(secrets.Role)
	if e != nil || len(roleKey) != 64 {
		return errors.New("ephemeral role key")
	}
	evalKey, e := hex.DecodeString(config.EvaluatorPublic)
	if e != nil || len(evalKey) != 32 {
		return errors.New("pinned evaluator key")
	}
	members := []federated.BootstrapMember{}
	for _, p := range config.Members {
		key, e := hex.DecodeString(p.Public)
		if e != nil {
			return e
		}
		members = append(members, federated.BootstrapMember{ID: p.ID, Endpoint: p.Endpoint, PublicKey: key, Role: p.Role})
	}
	mesh := federated.NewTransportMesh(config.ID, "synthetic-cpu")
	socket, e := mesh.ConfigureSocket(federated.SocketConfig{LocalID: config.ID, PrivateKey: transportKey, Members: members, Timeout: time.Duration(config.TimeoutSeconds) * time.Second, TrafficBytes: config.Traffic})
	if e != nil {
		return e
	}
	defer socket.Close()
	group, e := planprocess.OpenGroup(workerLimits(config))
	if e != nil {
		return e
	}
	cleanupGroup := group.Close
	defer func() { resultErr = errors.Join(resultErr, cleanupGroup()) }()
	args := []string{"-I", "-B", config.Peer, "--network-loop", "--network-max-requests", fmt.Sprint(bounds.WorkerCommands)}
	if config.Library != "" {
		args = append(args, "--public-library-root", config.Library)
	}
	worker, e := group.Start(ctx, planprocess.Config{Executable: config.Python, Directory: config.State, Args: args, MaxThreads: 1, MemoryLimitBytes: int64(config.Memory), GCPercent: 100, JSONLMaxBytes: federated.PilotFrameBytes})
	if e != nil {
		return e
	}
	defer func() { resultErr = errors.Join(resultErr, worker.Close()) }()
	cleanupGroup = closeNodeGroupOnCancel(ctx, group)
	var workerPeak resource.ProcessUsage
	proposerPublic := ""
	for _, pin := range config.Members {
		if pin.ID == "proposer" {
			proposerPublic = pin.Public
		}
	}
	pins := map[string]string{"issuer_id": "issuer", "issuer_key": config.IssuerPublic, "proposer_id": "proposer", "proposer_key": proposerPublic, "evaluator_id": "evaluator", "evaluator_key": config.EvaluatorPublic}
	initialize := map[string]any{"operation": "network-initialize", "pins": pins}
	if config.ID == "issuer" {
		initialize["evaluator_private"] = secrets.Evaluator
	}
	if _, e = call(ctx, worker, initialize); e != nil {
		return e
	}
	if config.ID == "proposer" {
		if e = socket.Listen(); e != nil {
			return e
		}
		fmt.Println(string(encode(map[string]any{"ready": true, "node_pid": os.Getpid(), "endpoint": config.Endpoint})))
		session, e := socket.Accept(ctx)
		if e != nil {
			return e
		}
		defer session.Close()
		if e = validateCounterpart(config, session.AuthenticatedPeer()); e != nil {
			return e
		}
		if e = agreePilotMode(ctx, session, config); e != nil {
			return e
		}
		var progress networkProgress
		if data, err := os.ReadFile(filepath.Join(config.State, "progress.json")); err == nil {
			if e = json.Unmarshal(data, &progress); e != nil {
				return e
			}
		}
		if config.Resume {
			raw, err := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
			if err != nil {
				return err
			}
			var sync networkProgressSync
			if err = json.Unmarshal(raw, &sync); err != nil {
				return err
			}
			if !ed25519.Verify(issuerKey, encode(sync.Progress), mustDecode(sync.Signature)) {
				return errors.New("resume progress issuer signature")
			}
			if sync.Rollback != nil {
				if sync.Rollback.Certificate.After != sync.Progress || sync.Progress.Sequence > uint64((int(^uint(0)>>1)-bounds.Reservations)/2) {
					return errors.New("rollback resume progress/bound mismatch")
				}
				progress, err = admitPeerRollback(config.State, progress, *sync.Rollback, issuerKey, true, bounds.Reservations+int(sync.Progress.Sequence)*2)
			} else {
				err = acceptResumeProgress(config.State, progress, sync.Progress)
			}
			if err != nil {
				return err
			}
			progress = sync.Progress
		}
		if progress.Sequence > uint64((int(^uint(0)>>1)-bounds.Reservations)/2) {
			return errors.New("resume reservation limit overflow")
		}
		reservationLimit := bounds.Reservations + int(progress.Sequence)*2
		for i := 0; i < config.Rounds+1; i++ {
			if e = consent(config.State); e != nil {
				return e
			}
			raw, e := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
			if e != nil {
				return e
			}
			var request networkRequest
			if e = json.Unmarshal(raw, &request); e != nil {
				return e
			}
			if request.Operation != "network-propose" || request.Pins["issuer_id"] != "issuer" || request.Pins["issuer_key"] != config.IssuerPublic {
				return errors.New("unknown/self-issued network job")
			}
			if !ed25519.Verify(issuerKey, []byte(request.SignedJob), mustDecode(request.Signature)) {
				return errors.New("modified signed issuer job")
			}
			if e = validateLiveJob([]byte(request.SignedJob), request.Signature, issuerKey); e != nil {
				return e
			}
			var issued myriad.IMCNetworkRoundJob
			_ = json.Unmarshal([]byte(request.SignedJob), &issued)
			if progress.Sequence > 0 && (issued.SessionID != progress.Session || issued.GenesisCheckpointHash != progress.Genesis || issued.CurrentParentCheckpointHash != progress.Parent || issued.LineageHash != progress.Lineage || issued.RoundSequence != progress.Sequence+1) {
				return errors.New("persisted proposer current-parent/sequence mismatch")
			}
			if e = reserveWorkBounded(config.State, request.SignedJob, reservationLimit); e != nil {
				return e
			}
			if e = consent(config.State); e != nil {
				return e
			}
			// One diagnostic marker for the first fresh signed synthetic task only.
			// Remote request fields cannot grant local file/probe authority.
			request.PhaseProbe = nil
			if i == 0 {
				request.PhaseProbe = phaseProbe
			}
			response, e := call(ctx, worker, request)
			if e != nil {
				return e
			}
			if observed, err := worker.Usage(); err == nil {
				workerPeak = observed
			}
			// Last round submits a zero update with honest explicit rejection fixture.
			if i == config.Rounds {
				var candidate map[string]any
				_ = json.Unmarshal(encode(response), &candidate)
				var delta map[string]map[string]any
				_ = json.Unmarshal(response["delta"], &delta)
				for _, item := range delta {
					data, _ := item["data"].(string)
					item["data"] = zeroBase64(data)
				}
				candidate["delta"] = delta
				// Hash actual concatenated zero float32 bytes, not base64 JSON.
				var zeroBytes []byte
				for _, item := range delta {
					data, _ := item["data"].(string)
					raw, _ := base64.StdEncoding.DecodeString(data)
					zeroBytes = append(zeroBytes, raw...)
				}
				candidate["parameter_delta_hash"] = hash(zeroBytes)
				response = map[string]json.RawMessage{}
				for k, v := range candidate {
					response[k] = encode(v)
				}
			}
			candidate := canonicalJSON(response)
			reply := networkResponse{Candidate: candidate, Signature: hex.EncodeToString(ed25519.Sign(transportKey, candidate)), PID: os.Getpid(), WorkerPID: json.RawMessage(response["pid"])}
			if e = consent(config.State); e != nil {
				return e
			}
			if e = session.Send(ctx, encode(reply)); e != nil {
				return e
			}
			ack, e := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
			if e != nil {
				return e
			}
			next, e := validateIssuerAck(issued, ack, issuerKey)
			if e != nil {
				return e
			}
			progress = next
			if e = progressHistory(config.State, progress); e != nil {
				return e
			}
			if e = save(filepath.Join(config.State, "progress.json"), encode(progress)); e != nil {
				return e
			}
		}
		if config.RollbackAtEnd {
			raw, err := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
			if err != nil {
				return err
			}
			var notice networkRollbackNotice
			if err = decodeContract(raw, &notice); err != nil {
				return err
			}
			progress, err = admitPeerRollback(config.State, progress, notice, issuerKey, false, reservationLimit)
			if err != nil {
				return err
			}
			if err = consent(config.State); err != nil {
				return err
			}
			if err = session.Send(ctx, encode(networkRollbackAck{Operation: "rollback-ack", Progress: progress, CertificateHash: hash(encode(notice))})); err != nil {
				return err
			}
		}
		sent, received := socket.Bytes()
		hostAfter, _ := hostSampler.Sample()
		fmt.Println(string(encode(map[string]any{"node_pid": os.Getpid(), "sent_bytes": sent, "received_bytes": received, "status": "proposer_done", "progress": progress, "worker_usage": workerPeak, "host_usage": hostAfter, "idle_cpu_ns_100ms": hostIdle.CPUTime - hostBefore.CPUTime, "worker_limits_do_not_bound_host": true})))
		return nil
	}
	if config.ID != "issuer" || !bytes.Equal(ed25519.PrivateKey(roleKey).Public().(ed25519.PublicKey), issuerKey) {
		return errors.New("issuer role key not pinned")
	}
	session, e := socket.Dial(ctx, config.RemoteID)
	if e != nil {
		return e
	}
	defer session.Close()
	if e = validateCounterpart(config, session.AuthenticatedPeer()); e != nil {
		return e
	}
	if e = agreePilotMode(ctx, session, config); e != nil {
		return e
	}
	if config.Steps < 1 || config.Steps > 64 || config.LearningRate <= 0 || config.LearningRate > 0.01 {
		return errors.New("explicit bounded network recipe required")
	}
	recipe := json.RawMessage(canonicalJSON(map[string]any{"config": map[string]any{"d_model": 32, "eos_token_id": 15, "ffn_dim": 64, "max_seq_len": 8, "n_heads": 4, "n_kv_heads": 2, "n_layers": 1, "vocab_size": 16}, "learning_rate": config.LearningRate, "max_delta_norm": 20.0, "min_improvement": 0.0001, "seed": 1701, "steps": config.Steps, "version": 1}))
	genesis, e := call(ctx, worker, map[string]any{"operation": "network-genesis", "recipe": recipe})
	if e != nil {
		return e
	}
	parent := genesis["checkpoint"]
	var genesisHash, fixtureHash, configHash, recipeHash string
	_ = json.Unmarshal(genesis["checkpoint_hash"], &genesisHash)
	_ = json.Unmarshal(genesis["fixture_hash"], &fixtureHash)
	_ = json.Unmarshal(genesis["model_config_hash"], &configHash)
	_ = json.Unmarshal(genesis["training_recipe_hash"], &recipeHash)
	progress, parent, e := loadIssuerProgress(config.State, config.Resume, parent, genesisHash)
	if e != nil {
		return e
	}
	parentHash, sessionID, lineage, sequenceStart := progress.Parent, progress.Session, progress.Lineage, progress.Sequence
	sequenceCount := uint64(bounds.Jobs)
	if config.RollbackAtEnd {
		sequenceCount++
	}
	if sequenceStart > ^uint64(0)-sequenceCount {
		return errors.New("network sequence overflow")
	}
	credential := hex.EncodeToString(roleKey[:16])
	kernel, e := controlkernel.OpenKernel(filepath.Join(config.State, "authority.journal"), controlkernel.WithExecutorAuthenticator(nodeAuth(credential)), controlkernel.WithVerifierAuthenticator(nodeAuth(credential)))
	if e != nil {
		return e
	}
	defer kernel.Close()
	if _, e := os.Stat(filepath.Join(config.State, "pending.json")); e == nil {
		if e = ReconcileNetworkPublication(config.State, kernel, issuerKey); e != nil {
			return e
		}
		return errors.New("restart reconciled uncertain publication to prior parent; no redispatch")
	}
	var resumeRollbackHash string
	if config.Resume {
		notice, err := committedRollback(config.State, progress, kernel, issuerKey)
		if err != nil {
			return err
		}
		if notice != nil {
			resumeRollbackHash = hash(encode(*notice))
		}
		sync := networkProgressSync{Progress: progress, Signature: hex.EncodeToString(ed25519.Sign(roleKey, encode(progress))), Rollback: notice}
		if err = consent(config.State); err != nil {
			return err
		}
		if err = session.Send(ctx, encode(sync)); err != nil {
			return err
		}
	}
	taskID := fmt.Sprintf("network-batch-%d", sequenceStart)
	if _, e = kernel.CreateTask(controlkernel.Task{ID: taskID, Goal: "explicit synthetic-public network rounds"}); e != nil {
		return e
	}
	for i := uint64(0); i < sequenceCount; i++ {
		round := sequenceRound(sequenceStart + i + 1)
		if _, e = kernel.AddNode(controlkernel.Node{ID: round, TaskID: taskID, Kind: "signed-imc-network"}); e != nil {
			return e
		}
	}
	if e = persistInitialCheckpoints(config.State, genesisHash, genesis["checkpoint"], parent, parentHash); e != nil {
		return e
	}
	if e = save(filepath.Join(config.State, "progress.json"), encode(progress)); e != nil {
		return e
	}
	if e = progressHistory(config.State, progress); e != nil {
		return e
	}
	rounds := []map[string]any{}
	var priorCommitted networkProgress
	var lastRequest networkRequest
	for i := 0; i < config.Rounds+1; i++ {
		if e = consent(config.State); e != nil {
			return e
		}
		round := fmt.Sprintf("round-%d", sequenceStart+uint64(i)+1)
		if e = kernel.TransitionNode(round, controlkernel.NodeReady, controlkernel.LeaseToken{}); e != nil {
			return e
		}
		lease, e := kernel.ClaimLease(round, credential, "explicit local issuer", time.Duration(config.TimeoutSeconds)*time.Second)
		if e != nil {
			return e
		}
		token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
		if e = kernel.TransitionNode(round, controlkernel.NodePreparing, token); e != nil {
			return e
		}
		freshNonce := make([]byte, 32)
		if _, e = rand.Read(freshNonce); e != nil {
			return e
		}
		nonce := hex.EncodeToString(freshNonce)
		intent, created, e := kernel.PrepareIntent(controlkernel.Intent{NodeID: round, Kind: "synthetic-model-publication", IdempotencyKey: sessionID + round, RequestHash: parentHash}, token)
		if e != nil || !created {
			return errors.New("durable logical round replay")
		}
		job := map[string]any{"protocol_version": 2, "issuer_id": "issuer", "expert_id": "synthetic-imc", "session_id": sessionID, "round_sequence": i + 1, "round_id": round, "genesis_checkpoint_hash": genesisHash, "current_parent_checkpoint_hash": parentHash, "lineage_hash": lineage, "model_config_hash": configHash, "curriculum_manifest_hash": fixtureHash, "dataset_scope": "synthetic-public-v1", "authorized_purpose": "local-network-training", "training_recipe_hash": recipeHash, "recipe_json": string(recipe), "proposer_id": "proposer", "evaluator_id": "evaluator", "proposer_key_hash": hash(session.Peer.PublicKey), "evaluator_key_hash": hash(evalKey), "nonce": nonce, "consent_epoch": 1, "lease_fence": token.Fence, "deadline_unix_ms": lease.ExpiresAt.UnixMilli()}
		signed := canonicalJSON(job)
		job["round_sequence"] = sequenceStart + uint64(i) + 1
		signed = canonicalJSON(job)
		if e = validateLiveJob(signed, hex.EncodeToString(ed25519.Sign(roleKey, signed)), issuerKey); e != nil {
			return e
		}
		request := networkRequest{Operation: "network-propose", SignedJob: string(signed), Signature: hex.EncodeToString(ed25519.Sign(roleKey, signed)), Pins: pins, Parent: parent}
		lastRequest = request
		if e = kernel.TransitionNode(round, controlkernel.NodeExecuting, token); e != nil {
			return e
		}
		if _, e = kernel.ValidateExecutorLease(credential, "network-issuer", round, token); e != nil {
			return e
		}
		adapter := &VerifiedRoundAdapter{Session: session, Worker: worker, EvaluatorKey: evalKey, CheckConsent: func() error { return consent(config.State) }}
		adapter.Commit = func(workCtx context.Context, evaluation map[string]json.RawMessage, receiptHash string) error {
			if err := workCtx.Err(); err != nil {
				return err
			}
			var candidate string
			_ = json.Unmarshal(evaluation["checkpoint_hash"], &candidate)
			if err := consent(config.State); err != nil {
				return err
			}
			active, err := os.ReadFile(filepath.Join(config.State, "active.json"))
			if err != nil || string(active) != parentHash {
				return errors.New("active current-parent CAS failed")
			}
			if _, err = kernel.ValidateExecutorLease(credential, "network-issuer", round, token); err != nil {
				return err
			}
			if _, err = kernel.StartIntent(intent.ID, token); err != nil {
				return err
			}
			stored, err := Checkpoint(config.State, json.RawMessage(canonicalJSON(evaluation["checkpoint"])))
			if err != nil || stored != candidate {
				return errors.New("immutable candidate checkpoint integrity")
			}
			after := networkProgress{Session: sessionID, Genesis: genesisHash, Parent: candidate, Lineage: hash([]byte(lineage + candidate)), Sequence: sequenceStart + uint64(i) + 1}
			if err = save(filepath.Join(config.State, "pending.json"), encode(networkPublication{Before: progress, After: after, IntentKey: sessionID + round})); err != nil {
				return err
			}
			defer func() { _ = ReconcileNetworkPublication(config.State, kernel, issuerKey) }()
			if _, err = kernel.RecordIntentResult(intent.ID, token, candidate, receiptHash); err != nil {
				return err
			}
			if err = kernel.TransitionNode(round, controlkernel.NodeVerifying, token); err != nil {
				return err
			}
			if _, err = kernel.RecordVerification("pinned-independent-evaluator", controlkernel.VerificationRequest{NodeID: round, Decision: controlkernel.VerificationPassed, EvidenceHash: receiptHash, ExpectedVerifierID: "network-evaluator"}); err != nil {
				return err
			}
			if err = kernel.TransitionNode(round, controlkernel.NodeCommitting, token); err != nil {
				return err
			}
			if err = workCtx.Err(); err != nil {
				return err
			}
			if err = consent(config.State); err != nil {
				return err
			}
			if _, err = kernel.ValidateExecutorLease(credential, "network-issuer", round, token); err != nil {
				return err
			}
			if err = save(filepath.Join(config.State, "active.json"), []byte(candidate)); err != nil {
				return err
			}
			if _, err = kernel.CommitIntent(intent.ID, token); err != nil {
				return err
			}
			if err = committedProgress(config.State, after); err != nil {
				return err
			}
			if err = progressHistory(config.State, after); err != nil {
				return err
			}
			if err = save(filepath.Join(config.State, "progress.json"), encode(after)); err != nil {
				return err
			}
			if err = kernel.TransitionNode(round, controlkernel.NodeSucceeded, token); err != nil {
				return err
			}
			return os.Remove(filepath.Join(config.State, "pending.json"))
		}
		if config.Execute == nil {
			return errors.New("Swarm governed executor injection required")
		}
		verified, e := config.Execute(ctx, IssuedRound{Round: round, CurrentParent: parentHash, Contract: encode(request)}, adapter)
		if e != nil {
			return e
		}
		proposed := adapter.Proposed
		evaluation := adapter.Evaluation
		var accepted bool
		_ = json.Unmarshal(evaluation["accepted"], &accepted)
		var candidateHash string
		_ = json.Unmarshal(evaluation["checkpoint_hash"], &candidateHash)
		receipt := map[string]any{"protocol_version": 2, "evaluator_id": "evaluator", "issued_job_hash": hash(signed), "round_id": round, "current_parent_checkpoint_hash": parentHash, "candidate_checkpoint_hash": candidateHash, "accepted": accepted}
		var receiptJSON, signatureJSON string
		_ = json.Unmarshal(evaluation["signed_receipt_json"], &receiptJSON)
		_ = json.Unmarshal(evaluation["receipt_signature"], &signatureJSON)
		receiptBytes := []byte(receiptJSON)
		receiptSignature := mustDecode(signatureJSON)
		if !ed25519.Verify(evalKey, receiptBytes, receiptSignature) {
			return errors.New("independent receipt authentication")
		}
		var verifiedReceipt map[string]any
		if e = json.Unmarshal(receiptBytes, &verifiedReceipt); e != nil {
			return e
		}
		for key, value := range receipt {
			if !bytes.Equal(encode(verifiedReceipt[key]), encode(value)) {
				return errors.New("receipt issued policy binding mismatch")
			}
		}
		for _, key := range []string{"before", "candidate", "active"} {
			encodedMetrics, ok := verifiedReceipt[key+"_metrics_json"].(string)
			if !ok || !bytes.Equal([]byte(encodedMetrics), canonicalJSON(json.RawMessage(evaluation[key]))) {
				return errors.New("signed evaluation metric mismatch")
			}
		}
		previous := parentHash
		if accepted {
			if !verified.Applied {
				return errors.New("accepted update lacks durable governed commit")
			}
			priorCommitted = progress
			parent = evaluation["checkpoint"]
			parentHash = candidateHash
			lineage = hash([]byte(lineage + candidateHash))
		}
		progress = networkProgress{Session: sessionID, Genesis: genesisHash, Parent: parentHash, Lineage: lineage, Sequence: sequenceStart + uint64(i) + 1}
		if e = persistAndAckIssuerProgress(config.State, progress, func(payload []byte) error {
			ack := networkProgressSync{Progress: progress, Signature: hex.EncodeToString(ed25519.Sign(roleKey, payload))}
			return session.Send(ctx, encode(ack))
		}); e != nil {
			return e
		}
		rounds = append(rounds, map[string]any{"round": round, "parent": previous, "genesis": genesisHash, "candidate_hash": candidateHash, "active_hash": parentHash, "accepted": accepted, "before": json.RawMessage(evaluation["before"]), "candidate": json.RawMessage(evaluation["candidate"]), "active": json.RawMessage(evaluation["active"]), "remote_os_pid": proposed.PID, "worker_pid": proposed.WorkerPID})
		if observed, err := worker.Usage(); err == nil {
			workerPeak = observed
		}
	}
	var rollbackProof any
	if config.RollbackAtEnd {
		if e = consent(config.State); e != nil {
			return e
		}
		target, err := findCommittedAncestor(config.State, priorCommitted, kernel)
		if err != nil {
			return err
		}
		round := sequenceRound(progress.Sequence + 1)
		if err = kernel.TransitionNode(round, controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
			return err
		}
		lease, err := kernel.ClaimLease(round, credential, "explicit bounded ancestor rollback", time.Duration(config.TimeoutSeconds)*time.Second)
		if err != nil {
			return err
		}
		token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
		if err = kernel.TransitionNode(round, controlkernel.NodePreparing, token); err != nil {
			return err
		}
		nonce := make([]byte, 32)
		if _, err = rand.Read(nonce); err != nil {
			return err
		}
		deadline := lease.ExpiresAt.UnixMilli()
		if limit, ok := ctx.Deadline(); ok && limit.UnixMilli() < deadline {
			deadline = limit.UnixMilli()
		}
		certificate := networkRollbackCertificate{ProtocolVersion: 1, Operation: "rollback", Before: progress, Target: target, TargetIntentKey: sessionID + sequenceRound(target.Sequence), RollbackIntentKey: sessionID + round, Nonce: hex.EncodeToString(nonce), ConsentEpoch: 1, LeaseFence: token.Fence, DeadlineUnixMS: deadline}
		certificate.After = networkProgress{Session: sessionID, Genesis: genesisHash, Parent: target.Parent, Sequence: progress.Sequence + 1}
		certificate.After.Lineage = rollbackLineage(progress, target, certificate.TargetIntentKey, certificate.After.Sequence)
		notice := networkRollbackNotice{Certificate: certificate, Signature: hex.EncodeToString(ed25519.Sign(roleKey, encode(certificate)))}
		if err = validateRollbackNotice(notice, issuerKey, time.Now(), true); err != nil {
			return err
		}
		if err = validateRollbackAncestor(config.State, notice, kernel); err != nil {
			return err
		}
		intent, created, err := kernel.PrepareIntent(controlkernel.Intent{NodeID: round, Kind: "synthetic-model-rollback", IdempotencyKey: certificate.RollbackIntentKey, RequestHash: hash(encode(certificate))}, token)
		if err != nil || !created {
			return errors.New("durable rollback replay")
		}
		if err = kernel.TransitionNode(round, controlkernel.NodeExecuting, token); err != nil {
			return err
		}
		data, e := os.ReadFile(filepath.Join(config.State, target.Parent+".json"))
		if e != nil {
			return e
		}
		var rollbackJob map[string]any
		_ = json.Unmarshal([]byte(lastRequest.SignedJob), &rollbackJob)
		rollbackJob["current_parent_checkpoint_hash"] = target.Parent
		rollbackJob["round_id"] = round
		rollbackJob["round_sequence"] = certificate.After.Sequence
		rollbackJob["lineage_hash"] = certificate.After.Lineage
		rollbackJob["nonce"] = certificate.Nonce
		rollbackJob["lease_fence"] = certificate.LeaseFence
		rollbackJob["deadline_unix_ms"] = certificate.DeadlineUnixMS
		signed := canonicalJSON(rollbackJob)
		lastRequest.Operation = "network-measure"
		lastRequest.SignedJob = string(signed)
		lastRequest.Signature = hex.EncodeToString(ed25519.Sign(roleKey, signed))
		lastRequest.Parent = data
		lastRequest.Candidate = nil
		if err = consent(config.State); err != nil {
			return err
		}
		if _, err = kernel.ValidateExecutorLease(credential, "network-issuer", round, token); err != nil {
			return err
		}
		measured, e := call(ctx, worker, lastRequest)
		if e != nil {
			return e
		}
		if err = publishRollback(ctx, config.State, kernel, credential, token, intent, notice, issuerKey); err != nil {
			return err
		}
		progress = certificate.After
		if err = consent(config.State); err != nil {
			return err
		}
		if err = session.Send(ctx, encode(notice)); err != nil {
			return err
		}
		ackRaw, err := receiveWithConsent(config.State, func() ([]byte, error) { return session.Receive(ctx) })
		if err != nil {
			return err
		}
		var ack networkRollbackAck
		if err = decodeContract(ackRaw, &ack); err != nil {
			return err
		}
		if ack.Operation != "rollback-ack" || ack.Progress != progress || ack.CertificateHash != hash(encode(notice)) {
			return errors.New("rollback peer durable acknowledgment mismatch")
		}
		committed, ok := kernel.IntentByKey(certificate.RollbackIntentKey)
		if !ok || committed.State != controlkernel.IntentCommitted {
			return errors.New("rollback journal outcome not committed")
		}
		rollbackProof = map[string]any{"from": parentHash, "to": target.Parent, "sequence": progress.Sequence, "before": certificate.Before, "after": progress, "notice": notice, "certificate_hash": hash(encode(notice)), "intent": committed, "metrics": json.RawMessage(measured["metrics"])}
		parent, parentHash, lineage = data, progress.Parent, progress.Lineage
	}
	sent, received := socket.Bytes()
	hostAfter, _ := hostSampler.Sample()
	fmt.Println(string(encode(map[string]any{"status": "NETWORK_PARTIAL", "node_pid": os.Getpid(), "rounds": rounds, "rollback": rollbackProof, "progress": progress, "resume_rollback_certificate_hash": resumeRollbackHash, "sent_bytes": sent, "received_bytes": received, "worker_bounds": group.Mechanism(), "worker_usage": workerPeak, "host_usage": hostAfter, "idle_cpu_ns_100ms": hostIdle.CPUTime - hostBefore.CPUTime, "joules_per_token": "unmeasured", "worker_limits_do_not_bound_host": true})))
	return nil
}
func mustDecode(s string) []byte { b, _ := hex.DecodeString(s); return b }
func zeroBase64(s string) string {
	data, e := base64.StdEncoding.DecodeString(s)
	if e != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(make([]byte, len(data)))
}

type VerifiedReceipt struct {
	Round, Parent, Candidate, Evaluator, ReceiptHash string
	Accepted                                         bool
	Applied                                          bool
}
type RoundRunner interface {
	RunRound(context.Context, IssuedRound) (VerifiedReceipt, error)
}

// VerifiedRoundAdapter is injectable into Swarm. Socket transport is authenticated
// and tensor/quality validation executes only in the canonical Ilaria worker.
// Evaluation alone does not claim publication; Applied stays false until the
// authoritative journal/CAS publication path commits it.
type VerifiedRoundAdapter struct {
	Session      *federated.SocketSession
	Worker       *planprocess.Process
	EvaluatorKey ed25519.PublicKey
	Evaluation   map[string]json.RawMessage
	Proposed     networkResponse
	Commit       func(context.Context, map[string]json.RawMessage, string) error
	CheckConsent func() error
}

func validateCheckpointReceipt(evaluation map[string]json.RawMessage, receipt map[string]any) error {
	var advertised string
	_ = json.Unmarshal(evaluation["checkpoint_hash"], &advertised)
	if advertised == "" || advertised != receipt["candidate_checkpoint_hash"] {
		return errors.New("advertised checkpoint mismatch")
	}
	checkpoint := evaluation["checkpoint"]
	if !json.Valid(checkpoint) || hash(canonicalJSON(checkpoint)) != advertised {
		return errors.New("canonical checkpoint bytes do not match signed receipt")
	}
	return nil
}

func (a *VerifiedRoundAdapter) RunRound(ctx context.Context, issued IssuedRound) (VerifiedReceipt, error) {
	if a.Session == nil || a.Worker == nil || a.CheckConsent == nil || len(a.EvaluatorKey) != 32 || issued.CurrentParent == "" || len(issued.Contract) == 0 {
		return VerifiedReceipt{}, errors.New("verified round authority unavailable")
	}
	var request networkRequest
	if e := json.Unmarshal(issued.Contract, &request); e != nil {
		return VerifiedReceipt{}, e
	}
	if e := a.CheckConsent(); e != nil {
		return VerifiedReceipt{}, e
	}
	if e := a.Session.Send(ctx, issued.Contract); e != nil {
		return VerifiedReceipt{}, e
	}
	raw, e := a.Session.Receive(ctx)
	if e != nil {
		return VerifiedReceipt{}, e
	}
	var proposed networkResponse
	if e = json.Unmarshal(raw, &proposed); e != nil {
		return VerifiedReceipt{}, e
	}
	if !ed25519.Verify(a.Session.AuthenticatedPeer().PublicKey, proposed.Candidate, mustDecode(proposed.Signature)) {
		return VerifiedReceipt{}, errors.New("proposer origin")
	}
	request.Operation = "network-evaluate"
	request.Candidate = proposed.Candidate
	if e := a.CheckConsent(); e != nil {
		return VerifiedReceipt{}, e
	}
	evaluation, e := call(ctx, a.Worker, request)
	if e != nil {
		return VerifiedReceipt{}, e
	}
	var signed, signature string
	_ = json.Unmarshal(evaluation["signed_receipt_json"], &signed)
	_ = json.Unmarshal(evaluation["receipt_signature"], &signature)
	if !ed25519.Verify(a.EvaluatorKey, []byte(signed), mustDecode(signature)) {
		return VerifiedReceipt{}, errors.New("independent evaluator receipt")
	}
	var receipt map[string]any
	var typedReceipt myriad.IMCNetworkRoundReceipt
	if e = decodeContract([]byte(signed), &typedReceipt); e != nil {
		return VerifiedReceipt{}, e
	}
	if !bytes.Equal(canonicalJSON(typedReceipt), []byte(signed)) {
		return VerifiedReceipt{}, errors.New("noncanonical generated receipt")
	}
	if e = json.Unmarshal([]byte(signed), &receipt); e != nil {
		return VerifiedReceipt{}, e
	}
	var job, candidateFields map[string]any
	_ = json.Unmarshal([]byte(request.SignedJob), &job)
	_ = json.Unmarshal(proposed.Candidate, &candidateFields)
	if receipt["issued_job_hash"] != hash([]byte(request.SignedJob)) || receipt["round_id"] != issued.Round || receipt["current_parent_checkpoint_hash"] != issued.CurrentParent || receipt["session_id"] != job["session_id"] || receipt["round_sequence"] != job["round_sequence"] || receipt["parameter_delta_hash"] != candidateFields["parameter_delta_hash"] || receipt["issuer_id"] != job["issuer_id"] || receipt["evaluator_id"] != job["evaluator_id"] {
		return VerifiedReceipt{}, errors.New("receipt exact issued identity")
	}
	if e = validateCheckpointReceipt(evaluation, receipt); e != nil {
		return VerifiedReceipt{}, e
	}
	for _, key := range []string{"training_recipe_hash", "model_config_hash", "genesis_checkpoint_hash", "lineage_hash", "consent_epoch", "lease_fence", "nonce", "deadline_unix_ms"} {
		if !bytes.Equal(encode(receipt[key]), encode(job[key])) {
			return VerifiedReceipt{}, errors.New("receipt issued policy/freshness mismatch")
		}
	}
	a.Evaluation = evaluation
	a.Proposed = proposed
	candidate, _ := receipt["candidate_checkpoint_hash"].(string)
	accepted, _ := receipt["accepted"].(bool)
	applied := false
	if accepted {
		if a.Commit == nil {
			return VerifiedReceipt{}, errors.New("durable commit authority required")
		}
		if e = a.Commit(ctx, evaluation, hash([]byte(signed))); e != nil {
			return VerifiedReceipt{}, e
		}
		applied = true
	}
	return VerifiedReceipt{Round: issued.Round, Parent: issued.CurrentParent, Candidate: candidate, Evaluator: "evaluator", ReceiptHash: hash([]byte(signed)), Accepted: accepted, Applied: applied}, nil
}

// SocketRelay uses the one admitted TransportMesh session; it is transport only,
// not a verifier or permission to commit a model.
type SocketRelay struct{ Session *federated.SocketSession }

func (r SocketRelay) Exchange(ctx context.Context, issued json.RawMessage) (json.RawMessage, error) {
	if r.Session == nil {
		return nil, errors.New("authenticated transport session required")
	}
	if err := r.Session.Send(ctx, issued); err != nil {
		return nil, err
	}
	return r.Session.Receive(ctx)
}
