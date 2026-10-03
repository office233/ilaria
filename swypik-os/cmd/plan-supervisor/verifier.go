package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
	wire "swypik-os/generated/swypeffects"
	"swypik-os/internal/planprocess"
)

// This DTO describes the Ilaria execution-evidence protocol, not model internals.
type observation struct {
	Format           string `json:"format"`
	ProtocolVersion  uint64 `json:"protocol_version"`
	Verified         bool   `json:"verified"`
	Purpose          string `json:"purpose"`
	TrainingEligible bool   `json:"training_eligible"`
	PrivacyClass     string `json:"privacy_class"`
	RequestID        string `json:"request_id"`
	RequestHash      string `json:"request_hash"`
	ResultHash       string `json:"result_hash"`
	ReceiptHash      string `json:"receipt_hash"`
	ModuleHash       string `json:"module_hash"`
	Function         string `json:"function"`
	Effect           string `json:"effect"`
	Capability       string `json:"capability"`
	TaskID           string `json:"task_id"`
	NodeID           string `json:"node_id"`
	AttemptID        string `json:"attempt_id"`
	ExecutorID       string `json:"executor_id"`
	GrantID          string `json:"grant_id"`
	LeaseID          string `json:"lease_id"`
	Fence            uint64 `json:"fence"`
	IntentID         string `json:"intent_id"`
	SignerKeyID      string `json:"signer_key_id"`
	OccurredAtUnixMS int64  `json:"occurred_at_unix_ms"`
	ValueType        string `json:"value_type"`
	ValueBytes       int    `json:"value_bytes"`
}

type streamVerifier struct {
	engine       *engine
	process      *planprocess.Process
	metrics      *runMetrics
	remainingCPU time.Duration
}

func (v *streamVerifier) Verify(ctx context.Context, request wire.EffectRequest, result wire.EffectResult, receipt wire.EffectReceipt, expected effects.Binding) (supervisor.Verification, error) {
	if v.process == nil {
		p, err := v.engine.startChild(v.engine.ctx, v.engine.config.VerifierExecutable, []string{"--stream", "--keys", v.engine.config.TrustRegistry})
		if err != nil {
			return supervisor.Verification{}, err
		}
		v.process = p
		v.metrics.ProcessStarts++
	}
	before, err := v.process.Usage()
	if err != nil {
		return supervisor.Verification{}, err
	}
	stop := v.process.Monitor(ctx, v.remainingCPU, v.engine.config.RSSLimitBytes, time.Duration(v.engine.config.SampleIntervalMS)*time.Millisecond)
	var operationErr error
	defer func() {
		if operationErr != nil {
			_ = v.process.Close()
			v.process = nil
		}
	}()
	envelope := struct {
		ProtocolVersion uint64             `json:"protocol_version"`
		Request         wire.EffectRequest `json:"request"`
		Result          wire.EffectResult  `json:"result"`
		Receipt         wire.EffectReceipt `json:"receipt"`
		Expected        effects.Binding    `json:"expected"`
	}{1, request, result, receipt, expected}
	operationErr = v.process.SendJSON(ctx, envelope)
	var raw []byte
	if operationErr == nil {
		raw, operationErr = v.process.ReadLine(ctx)
	}
	if meterErr := stop(); operationErr == nil {
		operationErr = meterErr
	}
	if operationErr != nil {
		_ = v.process.Close()
	}
	after, usageErr := v.process.Usage()
	if usageErr != nil && operationErr == nil {
		operationErr = usageErr
	}
	if after.CPUTime >= before.CPUTime {
		v.metrics.VerifierCPU += after.CPUTime - before.CPUTime
		v.remainingCPU -= after.CPUTime - before.CPUTime
	}
	v.metrics.VerifierPeakRSS = max(v.metrics.VerifierPeakRSS, after.PeakRSSBytes)
	if operationErr != nil {
		return supervisor.Verification{}, fmt.Errorf("independent verifier transport/budget failed")
	}
	if err := v.engine.checkBudget(); err != nil {
		operationErr = err
		return supervisor.Verification{}, err
	}
	var response struct {
		ProtocolVersion uint64       `json:"protocol_version"`
		RequestID       string       `json:"request_id"`
		Accepted        bool         `json:"accepted"`
		ErrorCode       string       `json:"error_code"`
		Observation     *observation `json:"observation,omitempty"`
	}
	if err := decodeFrame(raw, &response); err != nil {
		operationErr = err
		return supervisor.Verification{}, err
	}
	o := response.Observation
	if response.ProtocolVersion != 1 || response.RequestID != request.RequestID || !response.Accepted || response.ErrorCode != "" || o == nil || !o.Verified || o.TrainingEligible || o.PrivacyClass != "local_private" || o.Format != "ilaria-effect-observation-v1" || o.Purpose != "execution_evidence_only" || o.ProtocolVersion != 1 || o.RequestID != request.RequestID || o.ModuleHash != request.ModuleHash || o.Function != request.Function || o.Effect != request.Effect || o.Capability != request.Capability || o.IntentID != receipt.IntentID || o.SignerKeyID != receipt.SignerKeyID || o.ValueType != result.ValueType || o.ValueBytes != len(result.Value) || o.OccurredAtUnixMS != receipt.OccurredAtUnixMS {
		operationErr = supervisor.ErrVerification
		return supervisor.Verification{}, supervisor.ErrVerification
	}
	binding := effects.Binding{TaskID: o.TaskID, NodeID: o.NodeID, AttemptID: o.AttemptID, ExecutorID: o.ExecutorID, GrantID: o.GrantID, LeaseID: o.LeaseID, Fence: o.Fence}
	requestHash, _ := effects.RequestHash(request)
	resultHash, _ := effects.ResultHash(result)
	signingBytes, _ := effects.ReceiptSigningBytes(receipt)
	digest := sha256.Sum256(signingBytes)
	if binding != expected || o.RequestHash != requestHash || o.ResultHash != resultHash || o.ReceiptHash != hex.EncodeToString(digest[:]) {
		operationErr = supervisor.ErrVerification
		return supervisor.Verification{}, operationErr
	}
	return supervisor.Verification{Verified: true, RequestHash: o.RequestHash, ResultHash: o.ResultHash, ReceiptHash: o.ReceiptHash, Expected: binding}, nil
}

func (v *streamVerifier) Close() error {
	if v.process != nil {
		return v.process.Close()
	}
	return nil
}

type runMetrics struct {
	WallTime             time.Duration `json:"wall_time_ns"`
	HostCPU              time.Duration `json:"host_cpu_time_ns"`
	SwypCPU              time.Duration `json:"swyp_cpu_time_ns"`
	VerifierCPU          time.Duration `json:"verifier_cpu_time_ns"`
	HostPeakRSS          uint64        `json:"host_peak_rss_bytes"`
	SwypPeakRSS          uint64        `json:"swyp_peak_rss_bytes"`
	VerifierPeakRSS      uint64        `json:"verifier_peak_rss_bytes"`
	ProcessStarts        int           `json:"process_starts"`
	EnergyMeasured       bool          `json:"energy_measured"`
	KernelLimitMechanism string        `json:"kernel_limit_mechanism"`
}
