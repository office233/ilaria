package effects

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	wire "swypik-os/generated/swypeffects"
)

const (
	ProtocolVersion = 1
	MaxValueBytes   = 1 << 20
	MaxMessageBytes = 2 << 20
	ReceiptDomain   = "nexus.effect.receipt.v1\n"
)

var (
	idPattern         = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	identifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	hashPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func ValidateRequest(req wire.EffectRequest) error {
	if req.ProtocolVersion != ProtocolVersion || !idPattern.MatchString(req.RequestID) || !hashPattern.MatchString(req.ModuleHash) ||
		!identifierPattern.MatchString(req.Function) || !capabilityPattern.MatchString(req.Capability) {
		return fmt.Errorf("invalid effect request identity or protocol")
	}
	if !utf8.ValidString(req.Path) || len(req.Path) > 4096 {
		return fmt.Errorf("invalid effect request path")
	}
	switch req.Effect {
	case "clock.read":
		if req.Path != "" {
			return fmt.Errorf("clock.read must have an empty path")
		}
	case "fs.read":
		if !validResource(req.Path) {
			return fmt.Errorf("fs.read requires a clean relative resource path")
		}
	default:
		return fmt.Errorf("unsupported effect")
	}
	return nil
}

func canonicalHash(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func RequestHash(req wire.EffectRequest) (string, error)  { return canonicalHash(req) }
func ResultHash(result wire.EffectResult) (string, error) { return canonicalHash(result) }

func ReceiptSigningBytes(receipt wire.EffectReceipt) ([]byte, error) {
	receipt.Signature = nil
	raw, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	return append([]byte(ReceiptDomain), raw...), nil
}

func SignReceipt(receipt *wire.EffectReceipt, key ed25519.PrivateKey) error {
	if receipt == nil || len(key) != ed25519.PrivateKeySize {
		return fmt.Errorf("valid receipt and Ed25519 private key required")
	}
	raw, err := ReceiptSigningBytes(*receipt)
	if err != nil {
		return err
	}
	receipt.Signature = ed25519.Sign(key, raw)
	return nil
}

// DecodeStrict rejects duplicate keys, differently cased field aliases,
// unknown fields, malformed UTF-8 and trailing values before unmarshalling.
// Encoding/json's ordinary struct decoder alone accepts duplicate keys and
// case-insensitive aliases, which are ambiguous at an authority boundary.
func DecodeStrict(raw []byte, dst any) error {
	if len(raw) > MaxMessageBytes || !utf8.Valid(raw) {
		return fmt.Errorf("JSON message exceeds limit or is not UTF-8")
	}
	if err := validateUnicodeEscapes(raw); err != nil {
		return err
	}
	t := reflect.TypeOf(dst)
	if t == nil || t.Kind() != reflect.Pointer || reflect.ValueOf(dst).IsNil() {
		return fmt.Errorf("JSON destination must be a nonnil pointer")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := validateJSONValue(decoder, t.Elem(), 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("JSON message must contain exactly one value")
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(dst)
}

func validateUnicodeEscapes(raw []byte) error {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		if i+1 >= len(raw) {
			return fmt.Errorf("invalid JSON string escape")
		}
		if raw[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(raw) {
			return fmt.Errorf("invalid JSON Unicode escape")
		}
		value, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if err != nil || value >= 0xdc00 && value <= 0xdfff {
			return fmt.Errorf("invalid or unpaired JSON Unicode escape")
		}
		if value >= 0xd800 && value <= 0xdbff {
			if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
				return fmt.Errorf("unpaired JSON Unicode surrogate")
			}
			low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return fmt.Errorf("unpaired JSON Unicode surrogate")
			}
			i += 11
		} else {
			i += 5
		}
	}
	return nil
}

func validateJSONValue(decoder *json.Decoder, expected reflect.Type, depth int) error {
	if depth > 32 {
		return fmt.Errorf("JSON nesting exceeds limit")
	}
	for expected.Kind() == reflect.Pointer {
		expected = expected.Elem()
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if expected.Kind() == reflect.Slice && expected.Elem().Kind() == reflect.Uint8 {
		encoded, ok := token.(string)
		if !ok {
			return fmt.Errorf("byte values must use a canonical base64 string")
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded {
			return fmt.Errorf("byte values must use canonical padded base64")
		}
		return nil
	}
	delim, composite := token.(json.Delim)
	if !composite {
		if token == nil && expected.Kind() != reflect.Map && expected.Kind() != reflect.Slice && expected.Kind() != reflect.Pointer {
			return fmt.Errorf("null JSON scalar is not allowed")
		}
		return nil
	}
	switch delim {
	case '{':
		fields := make(map[string]reflect.Type)
		if expected.Kind() == reflect.Struct {
			for i := 0; i < expected.NumField(); i++ {
				field := expected.Field(i)
				name := strings.Split(field.Tag.Get("json"), ",")[0]
				if name != "" && name != "-" {
					fields[name] = field.Type
				}
			}
		} else if expected.Kind() != reflect.Map {
			return fmt.Errorf("unexpected JSON object")
		}
		seen := make(map[string]bool)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok || seen[key] {
				return fmt.Errorf("duplicate or invalid JSON field")
			}
			seen[key] = true
			var child reflect.Type
			if expected.Kind() == reflect.Map {
				child = expected.Elem()
			} else {
				child, ok = fields[key]
				if !ok {
					return fmt.Errorf("unknown JSON field %q", key)
				}
			}
			if err := validateJSONValue(decoder, child, depth+1); err != nil {
				return err
			}
		}
		if expected == reflect.TypeOf(wire.EffectRequest{}) || expected == reflect.TypeOf(wire.EffectResult{}) || expected == reflect.TypeOf(wire.EffectReceipt{}) {
			if len(seen) != len(fields) {
				return fmt.Errorf("wire JSON object requires every protocol field")
			}
		}
	case '[':
		if expected.Kind() != reflect.Slice && expected.Kind() != reflect.Array {
			return fmt.Errorf("unexpected JSON array")
		}
		for decoder.More() {
			if err := validateJSONValue(decoder, expected.Elem(), depth+1); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	_, err = decoder.Token()
	return err
}
