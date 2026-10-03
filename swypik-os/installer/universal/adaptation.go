package universal

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/devicesynth"
)

var (
	ErrAdaptationAlreadyStarted = errors.New("device adaptation operation already started")
	ErrKnownDriverAvailable     = errors.New("known driver artifact is available")
	ErrCanaryHealth             = errors.New("driver canary health check failed")
)

// AttestingVerifier is the verifier boundary required by the installer. The
// trust anchor is persisted into the device-adaptation journal before any
// protected state can be reached.
type AttestingVerifier interface {
	devicesynth.Verifier
	TrustAnchor() (devicesynth.VerifierTrustAnchor, error)
}

// DriverBuilder is an isolated, deterministic build boundary. Implementations
// return the exact artifact bytes whose hash is already declared by the
// synthesized candidate manifest.
type DriverBuilder interface {
	Build(context.Context, devicesynth.CandidateBundle) ([]byte, error)
}

// TrustedTestRunner produces externally-owned test evidence bound to the
// candidate, artifact and toolchain. Candidate-owned TestEvidence is never used
// as authority by this pipeline.
type TrustedTestRunner interface {
	Run(context.Context, devicesynth.CandidateBundle, []byte) ([]devicesynth.TrustedTestEvidence, error)
}

// CapabilityScanner reports the capabilities observed in the built artifact.
// The DeviceSynth verifier independently checks this observation against the
// declared/allowed Driver ABI vocabulary.
type CapabilityScanner interface {
	Scan(context.Context, devicesynth.CandidateBundle, []byte) (devicesynth.CapabilityObservation, error)
}

type DriverDomainReceipt struct {
	ExternalRef  string `json:"external_ref"`
	EvidenceHash string `json:"evidence_hash"`
}

type CanaryHealth struct {
	Passed       bool   `json:"passed"`
	EvidenceHash string `json:"evidence_hash,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// DriverDomainActivation is the complete authority/material bundle passed to
// the privileged driver-domain adapter. Resources are concrete probe facts;
// RequestedCapabilities are the independently verified logical request. The
// adapter must mint only a rights subset over these resources and bind every
// handle to LeaseFence.
type DriverDomainActivation struct {
	ControlNodeID         string
	ControlLeaseID        string
	ControlAttemptID      string
	LeaseFence            uint64
	Device                devicesynth.DeviceNode
	ResourceGrants        []devicesynth.ResourceGrant
	RequestedCapabilities []devicesynth.LogicalCapability
	Artifact              devicesynth.ArtifactManifest
	ArtifactBytes         []byte
}

// DriverDomain is the narrow activation boundary. ActivateCanary is the only
// external effect on the success path. Rollback belongs to the same lifecycle
// operation and returns durable evidence of the final external state.
type DriverDomain interface {
	ActivateCanary(context.Context, DriverDomainActivation) (DriverDomainReceipt, error)
	CheckCanary(context.Context, DriverDomainReceipt) (CanaryHealth, error)
	Rollback(context.Context, DriverDomainReceipt) (DriverDomainReceipt, error)
}

type DeviceAdaptationRequest struct {
	OperationID           string
	Hardware              devicesynth.HardwareManifest
	DeviceID              string
	ApprovedEvidence      []devicesynth.EvidenceReference
	AllowedCapabilities   []devicesynth.LogicalCapability
	AllowedResourceGrants []devicesynth.ResourceGrant
	JournalPath           string
	ExecutorCredential    string
	ExecutorOwner         string
	VerifierCredential    string
	LeaseTTL              time.Duration
}

type DeviceAdaptationResult struct {
	TaskID              string
	NodeID              string
	Intent              controlkernel.Intent
	Artifact            devicesynth.ArtifactManifest
	Trust               devicesynth.LocalTrustRecord
	Verification        devicesynth.VerificationResult
	ControlVerification controlkernel.Verification
	Canary              DriverDomainReceipt
	Health              CanaryHealth
	Journal             devicesynth.AdaptationRecord
}

// DeviceAdaptationCoordinator connects the Hardware Manifest / DeviceSynth
// state machine to Control Kernel authority and one capability-isolated driver
// domain. It deliberately does not own credentials, trust policy or the kernel
// journal lifecycle.
type DeviceAdaptationCoordinator struct {
	Kernel      *controlkernel.Kernel
	Matcher     devicesynth.DriverMatcher
	Synthesizer devicesynth.Synthesizer
	Verifier    AttestingVerifier
	Builder     DriverBuilder
	Tests       TrustedTestRunner
	Scanner     CapabilityScanner
	Domain      DriverDomain
	// RollbackTimeout bounds fail-safe cleanup after an unhealthy canary. Zero
	// selects the conservative default rather than disabling the timeout.
	RollbackTimeout time.Duration
}

func (c *DeviceAdaptationCoordinator) AdaptUnsupportedDevice(ctx context.Context, request DeviceAdaptationRequest) (DeviceAdaptationResult, error) {
	var result DeviceAdaptationResult
	if ctx == nil {
		return result, errors.New("nil adaptation context")
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if c == nil || c.Kernel == nil || c.Matcher == nil || c.Synthesizer == nil || c.Verifier == nil || c.Builder == nil || c.Tests == nil || c.Scanner == nil || c.Domain == nil {
		return result, errors.New("device adaptation requires kernel, matcher, synthesizer, verifier, builder, test runner, scanner and driver domain")
	}
	if strings.TrimSpace(request.OperationID) == "" || len(request.OperationID) > 128 {
		return result, errors.New("bounded operation id is required")
	}
	if strings.TrimSpace(request.DeviceID) == "" || strings.TrimSpace(request.JournalPath) == "" {
		return result, errors.New("device id and adaptation journal path are required")
	}
	if strings.TrimSpace(request.ExecutorCredential) == "" || strings.TrimSpace(request.ExecutorOwner) == "" || strings.TrimSpace(request.VerifierCredential) == "" {
		return result, errors.New("executor/verifier authority is required")
	}
	if request.LeaseTTL <= 0 {
		return result, errors.New("positive adaptation lease ttl is required")
	}
	if len(request.AllowedCapabilities) == 0 {
		return result, errors.New("explicit allowed capability set is required")
	}
	if len(request.AllowedResourceGrants) == 0 {
		return result, errors.New("explicit resource grant plan is required")
	}
	if err := request.Hardware.Validate(); err != nil {
		return result, fmt.Errorf("hardware manifest: %w", err)
	}

	device, err := deviceByID(request.Hardware, request.DeviceID)
	if err != nil {
		return result, err
	}
	binding, err := devicesynth.HardwareBindingHash(request.Hardware)
	if err != nil {
		return result, fmt.Errorf("hardware binding: %w", err)
	}
	anchor, err := c.Verifier.TrustAnchor()
	if err != nil {
		return result, fmt.Errorf("verifier trust anchor: %w", err)
	}
	if _, err := c.Kernel.ValidateVerifierCredential(request.VerifierCredential, anchor.VerifierID); err != nil {
		return result, fmt.Errorf("verifier preflight: %w", err)
	}

	journal, err := devicesynth.OpenJournalForHardware(request.JournalPath, binding, anchor)
	if err != nil {
		return result, fmt.Errorf("open adaptation journal: %w", err)
	}
	record, err := journal.Initialize(device.ID)
	if err != nil {
		return result, fmt.Errorf("initialize adaptation journal: %w", err)
	}
	if record.Current != devicesynth.StateProbe || record.Sequence != 0 {
		return result, fmt.Errorf("%w: journal is at %s sequence %d", ErrAdaptationAlreadyStarted, record.Current, record.Sequence)
	}

	operationDigest := devicesynth.HashBytes([]byte(request.OperationID + "\x00" + binding + "\x00" + device.ID))
	shortID := strings.TrimPrefix(operationDigest, "sha256:")
	if len(shortID) > 24 {
		shortID = shortID[:24]
	}
	result.TaskID = "driver-adaptation-" + shortID
	result.NodeID = "driver-activation-" + shortID

	if _, err := c.Kernel.CreateTask(controlkernel.Task{
		ID:   result.TaskID,
		Goal: "verify and activate a hardware-bound driver candidate",
		Metadata: map[string]string{
			"hardware_binding": binding,
			"device_id":        device.ID,
		},
	}); err != nil {
		return result, fmt.Errorf("create adaptation task: %w", err)
	}
	if _, err := c.Kernel.AddNode(controlkernel.Node{ID: result.NodeID, TaskID: result.TaskID, Kind: "driver.adaptation"}); err != nil {
		return result, fmt.Errorf("create adaptation node: %w", err)
	}
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		return result, fmt.Errorf("schedule adaptation node: %w", err)
	}
	lease, err := c.Kernel.ClaimLease(result.NodeID, request.ExecutorCredential, request.ExecutorOwner, request.LeaseTTL)
	if err != nil {
		return result, fmt.Errorf("claim adaptation lease: %w", err)
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodePreparing, token); err != nil {
		return result, fmt.Errorf("enter adaptation preparation: %w", err)
	}

	record, err = journal.Transition(devicesynth.StateProbe, devicesynth.StateMatch, devicesynth.TransitionEvidence{Reason: "hardware probe accepted by control-kernel task"})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateProbe, result.NodeID, token, err)
	}
	result.Journal = record
	matches, err := c.Matcher.Match(ctx, request.Hardware)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateMatch, result.NodeID, token, fmt.Errorf("driver match: %w", err))
	}
	match, err := matchForDevice(matches, device.ID)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateMatch, result.NodeID, token, err)
	}
	if !match.Unsupported {
		return result, c.failBeforeExternal(journal, devicesynth.StateMatch, result.NodeID, token, fmt.Errorf("%w: %s", ErrKnownDriverAvailable, match.KnownArtifact))
	}

	record, err = journal.Transition(devicesynth.StateMatch, devicesynth.StateSynthesize, devicesynth.TransitionEvidence{Reason: "no approved known driver matched target device"})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateMatch, result.NodeID, token, err)
	}
	result.Journal = record
	synthesis, err := c.Synthesizer.Synthesize(ctx, devicesynth.SynthesisRequest{
		UnsupportedDevices: []devicesynth.DeviceNode{device},
		Hardware:           request.Hardware,
		ABI:                devicesynth.ABI1(),
		Evidence:           append([]devicesynth.EvidenceReference(nil), request.ApprovedEvidence...),
	})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateSynthesize, result.NodeID, token, fmt.Errorf("driver synthesis: %w", err))
	}
	candidate := synthesis.Candidate
	candidateDigest, err := candidate.Digest()
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateSynthesize, result.NodeID, token, fmt.Errorf("candidate digest: %w", err))
	}
	record, err = journal.Transition(devicesynth.StateSynthesize, devicesynth.StateBuild, devicesynth.TransitionEvidence{CandidateDigest: candidateDigest, Reason: "candidate synthesized"})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateSynthesize, result.NodeID, token, err)
	}
	result.Journal = record

	artifactBytes, err := c.Builder.Build(ctx, candidate)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateBuild, result.NodeID, token, fmt.Errorf("isolated driver build: %w", err))
	}
	if len(artifactBytes) == 0 {
		return result, c.failBeforeExternal(journal, devicesynth.StateBuild, result.NodeID, token, errors.New("isolated driver build returned an empty artifact"))
	}
	record, err = journal.Transition(devicesynth.StateBuild, devicesynth.StateVerify, devicesynth.TransitionEvidence{CandidateDigest: candidateDigest, Reason: "isolated build completed"})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateBuild, result.NodeID, token, err)
	}
	result.Journal = record

	trustedTests, err := c.Tests.Run(ctx, candidate, artifactBytes)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("trusted driver tests: %w", err))
	}
	observation, err := c.Scanner.Scan(ctx, candidate, artifactBytes)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("capability scan: %w", err))
	}
	verification, err := c.Verifier.Verify(ctx, devicesynth.VerificationRequest{
		Hardware:              request.Hardware,
		Candidate:             candidate,
		AllowedCapabilities:   append([]devicesynth.LogicalCapability(nil), request.AllowedCapabilities...),
		AllowedResourceGrants: append([]devicesynth.ResourceGrant(nil), request.AllowedResourceGrants...),
		ApprovedEvidence:      append([]devicesynth.EvidenceReference(nil), request.ApprovedEvidence...),
		BuiltArtifact:         artifactBytes,
		TrustedTestEvidence:   trustedTests,
		CapabilityObservation: observation,
		TargetState:           devicesynth.StateActive,
	})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("deterministic verifier: %w", err))
	}
	result.Verification = verification
	if verification.VerifierID != anchor.VerifierID || verification.VerifierVersion != anchor.VerifierVersion {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, errors.New("verification result identity does not match configured trust anchor"))
	}
	if verifyErr := verification.Error(); verifyErr != nil {
		record, journalErr := journal.Transition(devicesynth.StateVerify, devicesynth.StateFailed, devicesynth.TransitionEvidence{CandidateDigest: candidateDigest, Reason: verifyErr.Error()})
		if journalErr == nil {
			result.Journal = record
		}
		if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeExecuting, token); err != nil {
			return result, errors.Join(verifyErr, journalErr, err)
		}
		if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeVerifying, token); err != nil {
			return result, errors.Join(verifyErr, journalErr, err)
		}
		evidenceHash, hashErr := devicesynth.CanonicalHash(verification)
		if hashErr != nil {
			return result, errors.Join(verifyErr, journalErr, hashErr)
		}
		controlVerification, recordErr := c.Kernel.RecordVerification(request.VerifierCredential, controlkernel.VerificationRequest{
			NodeID:             result.NodeID,
			Decision:           controlkernel.VerificationFailed,
			EvidenceHash:       evidenceHash,
			ExpectedVerifierID: verification.VerifierID,
		})
		result.ControlVerification = controlVerification
		terminalErr := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeFailed, token)
		return result, errors.Join(verifyErr, journalErr, recordErr, terminalErr)
	}
	resourceGrants, err := devicesynth.ValidateResourceGrantPlan(request.Hardware, device.ID, candidate.RequestedCapabilities, request.AllowedResourceGrants)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("driver resource grants: %w", err))
	}
	resourceGrantHash, err := devicesynth.CanonicalHash(resourceGrants)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("resource grant hash: %w", err))
	}

	artifact, err := devicesynth.NewArtifactManifest(candidate, verification)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, fmt.Errorf("artifact manifest: %w", err))
	}
	result.Artifact = artifact
	proof := devicesynth.TransitionEvidence{CandidateDigest: candidateDigest, ArtifactDigest: artifact.ArtifactDigest, Verification: &verification}
	record, err = journal.Transition(devicesynth.StateVerify, devicesynth.StateStage, proof)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateVerify, result.NodeID, token, err)
	}
	result.Journal = record

	requestHash, err := devicesynth.CanonicalHash(struct {
		HardwareBinding   string `json:"hardware_binding"`
		DeviceID          string `json:"device_id"`
		ArtifactDigest    string `json:"artifact_digest"`
		CandidateDigest   string `json:"candidate_digest"`
		ResourceGrantHash string `json:"resource_grant_hash"`
	}{binding, device.ID, artifact.ArtifactDigest, candidateDigest, resourceGrantHash})
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateStage, result.NodeID, token, err)
	}
	intent, _, err := c.Kernel.PrepareIntent(controlkernel.Intent{
		TaskID:         result.TaskID,
		NodeID:         result.NodeID,
		Kind:           "driver.canary.activate",
		IdempotencyKey: "driver-canary-" + shortID,
		RequestHash:    requestHash,
	}, token)
	if err != nil {
		return result, c.failBeforeExternal(journal, devicesynth.StateStage, result.NodeID, token, fmt.Errorf("prepare canary intent: %w", err))
	}
	result.Intent = intent
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeExecuting, token); err != nil {
		return result, fmt.Errorf("enter driver execution: %w", err)
	}
	if _, err := c.Kernel.StartIntent(intent.ID, token); err != nil {
		return result, fmt.Errorf("start canary intent: %w", err)
	}

	canary, err := c.Domain.ActivateCanary(ctx, DriverDomainActivation{
		ControlNodeID:         result.NodeID,
		ControlLeaseID:        lease.ID,
		ControlAttemptID:      lease.AttemptID,
		LeaseFence:            lease.Fence,
		Device:                device,
		ResourceGrants:        append([]devicesynth.ResourceGrant(nil), resourceGrants...),
		RequestedCapabilities: append([]devicesynth.LogicalCapability(nil), candidate.RequestedCapabilities...),
		Artifact:              artifact,
		ArtifactBytes:         append([]byte(nil), artifactBytes...),
	})
	if err != nil || !validEvidenceReceipt(canary) {
		if err == nil {
			err = errors.New("driver domain returned invalid canary receipt")
		}
		return result, c.escalateStartedIntent(result.NodeID, intent.ID, token, fmt.Errorf("activate canary: %w", err))
	}
	result.Canary = canary
	record, err = journal.Transition(devicesynth.StateStage, devicesynth.StateCanary, proof)
	if err != nil {
		return result, c.escalateStartedIntent(result.NodeID, intent.ID, token, fmt.Errorf("record canary state: %w", err))
	}
	result.Journal = record

	health, healthErr := c.Domain.CheckCanary(ctx, canary)
	result.Health = health
	if healthErr != nil || !health.Passed || !validDigest(health.EvidenceHash) {
		rollbackErr := c.rollbackFailedCanary(journal, proof, result.NodeID, intent.ID, token, request.VerifierCredential, verification.VerifierID, canary, health, healthErr)
		if latest, loadErr := journal.Load(); loadErr == nil {
			result.Journal = latest
		} else {
			rollbackErr = errors.Join(rollbackErr, loadErr)
		}
		if latestIntent, ok := c.Kernel.IntentByKey(result.Intent.IdempotencyKey); ok {
			result.Intent = latestIntent
		}
		return result, rollbackErr
	}

	resultHash, err := devicesynth.CanonicalHash(struct {
		Canary DriverDomainReceipt `json:"canary"`
		Health CanaryHealth        `json:"health"`
	}{canary, health})
	if err != nil {
		return result, c.escalateStartedIntent(result.NodeID, intent.ID, token, err)
	}
	intent, err = c.Kernel.RecordIntentResult(intent.ID, token, canary.ExternalRef, resultHash)
	if err != nil {
		return result, c.escalateStartedIntent(result.NodeID, result.Intent.ID, token, fmt.Errorf("record canary result: %w", err))
	}
	result.Intent = intent
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeVerifying, token); err != nil {
		return result, c.escalateResultIntent(result.NodeID, intent.ID, token, controlkernel.NodeExecuting, err)
	}
	controlEvidenceHash, err := devicesynth.CanonicalHash(struct {
		Attestation *devicesynth.VerificationAttestation `json:"attestation"`
		Canary      DriverDomainReceipt                  `json:"canary"`
		Health      CanaryHealth                         `json:"health"`
	}{verification.Attestation, canary, health})
	if err != nil {
		return result, c.escalateResultIntent(result.NodeID, intent.ID, token, controlkernel.NodeVerifying, err)
	}
	controlVerification, err := c.Kernel.RecordVerification(request.VerifierCredential, controlkernel.VerificationRequest{
		NodeID:             result.NodeID,
		Decision:           controlkernel.VerificationPassed,
		EvidenceHash:       controlEvidenceHash,
		ExpectedVerifierID: verification.VerifierID,
	})
	if err != nil {
		return result, c.escalateResultIntent(result.NodeID, intent.ID, token, controlkernel.NodeVerifying, fmt.Errorf("record control verification: %w", err))
	}
	result.ControlVerification = controlVerification
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeCommitting, token); err != nil {
		return result, fmt.Errorf("enter driver commit: %w", err)
	}
	intent, err = c.Kernel.CommitIntent(intent.ID, token)
	if err != nil {
		return result, fmt.Errorf("commit canary intent: %w", err)
	}
	result.Intent = intent
	healthOK := true
	activeProof := proof
	activeProof.HealthPassed = &healthOK
	record, err = journal.Transition(devicesynth.StateCanary, devicesynth.StateActive, activeProof)
	if err != nil {
		return result, fmt.Errorf("record active driver state: %w", err)
	}
	result.Journal = record
	trust, err := devicesynth.NewLocalTrustRecord(artifact, verification, devicesynth.StateActive)
	if err != nil {
		return result, fmt.Errorf("create local trust record: %w", err)
	}
	result.Trust = trust
	if err := c.Kernel.TransitionNode(result.NodeID, controlkernel.NodeSucceeded, token); err != nil {
		return result, fmt.Errorf("complete adaptation node: %w", err)
	}
	return result, nil
}

func (c *DeviceAdaptationCoordinator) failBeforeExternal(journal *devicesynth.Journal, current devicesynth.AdaptationState, nodeID string, token controlkernel.LeaseToken, cause error) error {
	var journalErr error
	if current != devicesynth.StateFailed {
		_, journalErr = journal.Transition(current, devicesynth.StateFailed, devicesynth.TransitionEvidence{Reason: cause.Error()})
	}
	nodeErr := c.Kernel.TransitionNode(nodeID, controlkernel.NodeFailed, token)
	return errors.Join(cause, journalErr, nodeErr)
}

func (c *DeviceAdaptationCoordinator) escalateStartedIntent(nodeID, intentID string, token controlkernel.LeaseToken, cause error) error {
	_, markErr := c.Kernel.MarkIntentUncertain(intentID, token)
	transitionErr := c.Kernel.TransitionNode(nodeID, controlkernel.NodeUncertain, token)
	var reconcileErr, operatorErr error
	if transitionErr == nil {
		_, reconcileErr = c.Kernel.BeginReconciliation(intentID)
		if reconcileErr == nil {
			operatorErr = c.Kernel.TransitionNode(nodeID, controlkernel.NodeOperatorRequired, token)
		}
	}
	return errors.Join(cause, markErr, transitionErr, reconcileErr, operatorErr)
}

func (c *DeviceAdaptationCoordinator) escalateResultIntent(nodeID, intentID string, token controlkernel.LeaseToken, from controlkernel.NodeState, cause error) error {
	transitionErr := c.Kernel.TransitionNode(nodeID, controlkernel.NodeUncertain, token)
	if transitionErr != nil && from != controlkernel.NodeUncertain {
		return errors.Join(cause, transitionErr)
	}
	_, reconcileErr := c.Kernel.BeginReconciliation(intentID)
	var operatorErr error
	if reconcileErr == nil {
		operatorErr = c.Kernel.TransitionNode(nodeID, controlkernel.NodeOperatorRequired, token)
	}
	return errors.Join(cause, reconcileErr, operatorErr)
}

func (c *DeviceAdaptationCoordinator) rollbackFailedCanary(journal *devicesynth.Journal, proof devicesynth.TransitionEvidence, nodeID, intentID string, token controlkernel.LeaseToken, verifierCredential, verifierID string, canary DriverDomainReceipt, health CanaryHealth, healthErr error) error {
	reason := strings.TrimSpace(health.Reason)
	if healthErr != nil {
		if reason == "" {
			reason = healthErr.Error()
		}
	} else if reason == "" {
		reason = ErrCanaryHealth.Error()
	}
	rollbackEvidence := devicesynth.TransitionEvidence{CandidateDigest: proof.CandidateDigest, ArtifactDigest: proof.ArtifactDigest, Verification: proof.Verification, Reason: reason}
	if _, err := journal.Transition(devicesynth.StateCanary, devicesynth.StateRollback, rollbackEvidence); err != nil {
		return c.escalateStartedIntent(nodeID, intentID, token, errors.Join(ErrCanaryHealth, healthErr, err))
	}
	rollbackTimeout := c.RollbackTimeout
	if rollbackTimeout <= 0 {
		rollbackTimeout = 30 * time.Second
	}
	rollbackCtx, cancelRollback := context.WithTimeout(context.Background(), rollbackTimeout)
	defer cancelRollback()
	rollback, err := c.Domain.Rollback(rollbackCtx, canary)
	if err != nil || !validEvidenceReceipt(rollback) {
		if err == nil {
			err = errors.New("driver domain returned invalid rollback receipt")
		}
		return c.escalateStartedIntent(nodeID, intentID, token, errors.Join(ErrCanaryHealth, healthErr, fmt.Errorf("rollback canary: %w", err)))
	}
	resultHash, err := devicesynth.CanonicalHash(struct {
		Canary   DriverDomainReceipt `json:"canary"`
		Health   CanaryHealth        `json:"health"`
		Rollback DriverDomainReceipt `json:"rollback"`
		Error    string              `json:"health_error,omitempty"`
	}{canary, health, rollback, errorString(healthErr)})
	if err != nil {
		return c.escalateStartedIntent(nodeID, intentID, token, errors.Join(ErrCanaryHealth, healthErr, err))
	}
	intent, err := c.Kernel.RecordIntentResult(intentID, token, rollback.ExternalRef, resultHash)
	if err != nil {
		return c.escalateStartedIntent(nodeID, intentID, token, errors.Join(ErrCanaryHealth, healthErr, err))
	}
	if err := c.Kernel.TransitionNode(nodeID, controlkernel.NodeVerifying, token); err != nil {
		return c.escalateResultIntent(nodeID, intent.ID, token, controlkernel.NodeExecuting, errors.Join(ErrCanaryHealth, healthErr, err))
	}
	evidenceHash, hashErr := devicesynth.CanonicalHash(struct {
		RollbackResult string `json:"rollback_result"`
		HealthReason   string `json:"health_reason"`
	}{resultHash, reason})
	if hashErr != nil {
		return c.escalateResultIntent(nodeID, intent.ID, token, controlkernel.NodeVerifying, errors.Join(ErrCanaryHealth, healthErr, hashErr))
	}
	_, recordErr := c.Kernel.RecordVerification(verifierCredential, controlkernel.VerificationRequest{
		NodeID:             nodeID,
		Decision:           controlkernel.VerificationFailed,
		EvidenceHash:       evidenceHash,
		ExpectedVerifierID: verifierID,
	})
	if recordErr != nil {
		return c.escalateResultIntent(nodeID, intent.ID, token, controlkernel.NodeVerifying, errors.Join(ErrCanaryHealth, healthErr, recordErr))
	}
	if err := c.Kernel.TransitionNode(nodeID, controlkernel.NodeUncertain, token); err != nil {
		return errors.Join(ErrCanaryHealth, healthErr, err)
	}
	if _, err := c.Kernel.BeginReconciliation(intent.ID); err != nil {
		return errors.Join(ErrCanaryHealth, healthErr, err)
	}
	if _, err := c.Kernel.CommitReconciledIntent(intent.ID, rollback.ExternalRef, resultHash); err != nil {
		return errors.Join(ErrCanaryHealth, healthErr, err)
	}
	if err := c.Kernel.TransitionNode(nodeID, controlkernel.NodeFailed, token); err != nil {
		return errors.Join(ErrCanaryHealth, healthErr, err)
	}
	_, journalErr := journal.Transition(devicesynth.StateRollback, devicesynth.StateFailed, devicesynth.TransitionEvidence{Reason: reason})
	return errors.Join(ErrCanaryHealth, healthErr, journalErr)
}

func deviceByID(manifest devicesynth.HardwareManifest, id string) (devicesynth.DeviceNode, error) {
	for _, device := range manifest.Graph.Devices {
		if device.ID == id {
			return device, nil
		}
	}
	return devicesynth.DeviceNode{}, fmt.Errorf("device %q is not present in hardware manifest", id)
}

func matchForDevice(matches []devicesynth.MatchResult, deviceID string) (devicesynth.MatchResult, error) {
	var found *devicesynth.MatchResult
	for i := range matches {
		if matches[i].DeviceID != deviceID {
			continue
		}
		if found != nil {
			return devicesynth.MatchResult{}, fmt.Errorf("driver matcher returned duplicate results for device %q", deviceID)
		}
		copyMatch := matches[i]
		found = &copyMatch
	}
	if found == nil {
		return devicesynth.MatchResult{}, fmt.Errorf("driver matcher returned no result for device %q", deviceID)
	}
	if found.Unsupported && strings.TrimSpace(found.KnownArtifact) != "" {
		return devicesynth.MatchResult{}, fmt.Errorf("driver matcher result for %q is internally inconsistent", deviceID)
	}
	return *found, nil
}

func validEvidenceReceipt(receipt DriverDomainReceipt) bool {
	return strings.TrimSpace(receipt.ExternalRef) != "" && validDigest(receipt.EvidenceHash)
}

func validDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") {
		return false
	}
	raw := strings.TrimPrefix(value, "sha256:")
	if len(raw) != 64 {
		return false
	}
	_, err := hex.DecodeString(raw)
	return err == nil
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
