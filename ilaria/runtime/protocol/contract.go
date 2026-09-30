package protocol

import (
	"encoding/hex"
	"fmt"
	"strings"
	"unicode"
)

const (
	Version         uint64 = 1
	MaxPPM          uint64 = 1_000_000
	MaxIDBytes             = 256
	SHA256HexLength        = 64
)

type PrivacyClass string

const (
	PrivacyPublic            PrivacyClass = "PUBLIC"
	PrivacyCurated           PrivacyClass = "CURATED"
	PrivacyDeviceNonPersonal PrivacyClass = "DEVICE_NONPERSONAL"
	PrivacyLocalPrivate      PrivacyClass = "LOCAL_PRIVATE"
	PrivacySensitive         PrivacyClass = "SENSITIVE"
	PrivacyForbiddenGlobal   PrivacyClass = "FORBIDDEN_GLOBAL"
)

func ValidateVersion(version uint64) error {
	if version != Version {
		return fmt.Errorf("protocol: unsupported version %d, want %d", version, Version)
	}
	return nil
}

func ValidatePPM(field string, value uint64) error {
	if value > MaxPPM {
		return fmt.Errorf("%s: %d exceeds %d ppm", field, value, MaxPPM)
	}
	return nil
}

func ValidateIdentifier(field, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s: empty", field)
	}
	if len(value) > MaxIDBytes {
		return fmt.Errorf("%s: exceeds %d bytes", field, MaxIDBytes)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s: contains a control character", field)
		}
	}
	return nil
}

func ValidateSHA256(field, value string, optional bool) error {
	if value == "" && optional {
		return nil
	}
	if len(value) != SHA256HexLength || value != strings.ToLower(value) {
		return fmt.Errorf("%s: must be a lowercase sha256 hex digest", field)
	}
	if _, err := hex.DecodeString(value); err != nil {
		return fmt.Errorf("%s: invalid sha256 hex: %w", field, err)
	}
	return nil
}

func ParsePrivacyClass(raw string) (PrivacyClass, error) {
	p := PrivacyClass(raw)
	switch p {
	case PrivacyPublic, PrivacyCurated, PrivacyDeviceNonPersonal,
		PrivacyLocalPrivate, PrivacySensitive, PrivacyForbiddenGlobal:
		return p, nil
	default:
		return "", fmt.Errorf("privacy_class: unsupported value %q", raw)
	}
}

func IsGloballyTransferable(raw string) (bool, error) {
	p, err := ParsePrivacyClass(raw)
	if err != nil {
		return false, err
	}
	switch p {
	case PrivacyPublic, PrivacyCurated, PrivacyDeviceNonPersonal:
		return true, nil
	case PrivacyLocalPrivate, PrivacySensitive, PrivacyForbiddenGlobal:
		return false, nil
	default:
		return false, fmt.Errorf("privacy_class: unhandled value %q", raw)
	}
}
