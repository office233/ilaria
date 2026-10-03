package world

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

func Validate(event myriad.WorldEvent) error {
	if err := protocol.ValidateVersion(event.ProtocolVersion); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("event_id", event.EventID); err != nil {
		return err
	}
	if event.TimestampDeltaMS < 0 {
		return fmt.Errorf("timestamp_delta_ms: must be non-negative")
	}
	if err := protocol.ValidateIdentifier("device_class", event.DeviceClass); err != nil {
		return err
	}
	if err := protocol.ValidateSHA256("device_model_hash", event.DeviceModelHash, true); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("source_namespace", event.SourceNamespace); err != nil {
		return err
	}
	if err := protocol.ValidateIdentifier("observation_type", event.ObservationType); err != nil {
		return err
	}
	if err := protocol.ValidatePPM("confidence_ppm", event.ConfidencePPM); err != nil {
		return err
	}
	if _, err := protocol.ParsePrivacyClass(event.PrivacyClass); err != nil {
		return err
	}
	for key := range event.Features {
		if err := protocol.ValidateIdentifier("feature key", key); err != nil {
			return err
		}
	}
	if strings.TrimSpace(event.Verifier) != "" {
		if err := protocol.ValidateIdentifier("verifier", event.Verifier); err != nil {
			return err
		}
		if strings.TrimSpace(event.Result) == "" {
			return fmt.Errorf("world event: verifier is set but result is empty")
		}
	}
	return nil
}

func Hash(event myriad.WorldEvent) (string, error) {
	if err := Validate(event); err != nil {
		return "", err
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return "", fmt.Errorf("world event: canonical json: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func IsVerified(event myriad.WorldEvent) bool {
	return strings.TrimSpace(event.Verifier) != "" && strings.TrimSpace(event.Result) != ""
}

func IsGloballyTransferable(event myriad.WorldEvent) (bool, error) {
	if err := Validate(event); err != nil {
		return false, err
	}
	return protocol.IsGloballyTransferable(event.PrivacyClass)
}
