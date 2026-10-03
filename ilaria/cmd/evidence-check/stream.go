package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"

	effects "ilaria/generated/swypeffects"
	"ilaria/runtime/evidence"
)

// Stream envelopes are supplied by the trusted supervisor, not by a guest.
// In particular Expected must retain independent control-plane context.
type streamEnvelope struct {
	ProtocolVersion uint64                     `json:"protocol_version"`
	Request         effects.EffectRequest      `json:"request"`
	Result          effects.EffectResult       `json:"result"`
	Receipt         effects.EffectReceipt      `json:"receipt"`
	Expected        evidence.ExpectedExecution `json:"expected"`
}

type streamResponse struct {
	ProtocolVersion uint64                `json:"protocol_version"`
	RequestID       string                `json:"request_id"`
	Accepted        bool                  `json:"accepted"`
	ErrorCode       string                `json:"error_code"`
	Observation     *evidence.Observation `json:"observation,omitempty"`
}

func validateStreamLimits(envelope streamEnvelope) error {
	if len(envelope.Result.Value) > evidence.MaxValueBytes {
		return fmt.Errorf("decoded evidence result exceeds %d bytes", evidence.MaxValueBytes)
	}
	if len(envelope.Request.Path) > evidence.MaxPathBytes {
		return fmt.Errorf("evidence request path exceeds %d bytes", evidence.MaxPathBytes)
	}
	for _, name := range []string{envelope.Request.Function, envelope.Request.Capability, envelope.Receipt.Capability} {
		if len(name) > evidence.MaxNameBytes {
			return fmt.Errorf("evidence semantic name exceeds %d bytes", evidence.MaxNameBytes)
		}
	}
	for _, id := range []string{
		envelope.Request.RequestID, envelope.Result.RequestID, envelope.Receipt.RequestID,
		envelope.Receipt.TaskID, envelope.Receipt.NodeID, envelope.Receipt.AttemptID,
		envelope.Receipt.ExecutorID, envelope.Receipt.GrantID, envelope.Receipt.LeaseID,
		envelope.Receipt.IntentID, envelope.Receipt.SignerKeyID,
		envelope.Expected.TaskID, envelope.Expected.NodeID, envelope.Expected.AttemptID,
		envelope.Expected.ExecutorID, envelope.Expected.GrantID, envelope.Expected.LeaseID, envelope.Expected.IntentID,
	} {
		if len(id) > evidence.MaxIdentifierBytes {
			return fmt.Errorf("evidence identifier exceeds %d bytes", evidence.MaxIdentifierBytes)
		}
	}
	return nil
}

// runStream processes one envelope before reading the next, writing directly
// to the transport so each response is visible without a buffered flush.
// A framing error is fatal: continuing could associate later evidence with
// the wrong outstanding supervisor request. Semantic rejection is correlated.
func runStream(input io.Reader, output io.Writer, verifier *evidence.Verifier) error {
	if input == nil || verifier == nil {
		return fmt.Errorf("evidence stream requires input and an explicitly trusted verifier")
	}
	scanner := bufio.NewScanner(input)
	// Allow a maximum-sized document plus CRLF, then enforce the document bound
	// separately. The scanner never retains an unbounded transport frame.
	scanner.Buffer(make([]byte, 64<<10), evidence.MaxJSONBytes+2)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var envelope streamEnvelope
		if err := evidence.DecodeStrict(scanner.Bytes(), &envelope); err != nil {
			return fmt.Errorf("invalid evidence stream envelope: %w", err)
		}
		if err := validateStreamLimits(envelope); err != nil {
			return err
		}
		response := streamResponse{ProtocolVersion: evidence.ProtocolVersion, RequestID: envelope.Request.RequestID}
		if envelope.ProtocolVersion != evidence.ProtocolVersion {
			response.ErrorCode = "unsupported_protocol"
		} else {
			observation, err := verifier.Verify(envelope.Request, envelope.Result, envelope.Receipt, envelope.Expected)
			if err != nil {
				response.ErrorCode = "evidence_rejected"
			} else {
				response.Accepted = true
				response.Observation = &observation
			}
		}
		if err := encoder.Encode(response); err != nil {
			return fmt.Errorf("write evidence stream response: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read evidence stream: %w", err)
	}
	return nil
}
