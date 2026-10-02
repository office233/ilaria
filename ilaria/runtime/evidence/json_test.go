package evidence

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	effects "ilaria/generated/swypeffects"
)

func requestJSON(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(executionFixture(t).request)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestStrictRequestJSONRejectsAmbiguousOrIncompleteEnvelopes(t *testing.T) {
	valid := requestJSON(t)
	cases := map[string]string{
		"duplicate":         strings.Replace(valid, `"request_id":"run:1"`, `"request_id":"run:1","request_id":"run:1"`, 1),
		"escaped_duplicate": strings.Replace(valid, `"request_id":"run:1"`, `"request_id":"run:1","request_\u0069d":"run:1"`, 1),
		"case_alias":        strings.Replace(valid, `"request_id"`, `"Request_ID"`, 1),
		"go_name_alias":     strings.Replace(valid, `"request_id"`, `"RequestID"`, 1),
		"extra_field":       strings.TrimSuffix(valid, "}") + `,"signature":"self-issued"}`,
		"missing_path":      strings.Replace(valid, `,"path":"input.txt"`, "", 1),
		"null_string":       strings.Replace(valid, `"path":"input.txt"`, `"path":null`, 1),
		"null_version":      strings.Replace(valid, `"protocol_version":1`, `"protocol_version":null`, 1),
		"fraction_version":  strings.Replace(valid, `"protocol_version":1`, `"protocol_version":1.0`, 1),
		"negative_version":  strings.Replace(valid, `"protocol_version":1`, `"protocol_version":-1`, 1),
		"overflow_version":  strings.Replace(valid, `"protocol_version":1`, `"protocol_version":18446744073709551616`, 1),
		"quoted_version":    strings.Replace(valid, `"protocol_version":1`, `"protocol_version":"1"`, 1),
		"trailing_object":   valid + `{}`,
		"trailing_invalid":  valid + `oops`,
		"null_root":         "null",
		"array_root":        "[]",
		"empty_document":    "",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			var request effects.EffectRequest
			if err := DecodeStrict([]byte(raw), &request); err == nil {
				t.Fatal("ambiguous or incomplete request accepted")
			}
		})
	}
	var decoded effects.EffectRequest
	if err := DecodeStrict([]byte(" \n"+valid+"\t\r\n"), &decoded); err != nil {
		t.Fatal("valid whitespace-delimited document rejected", err)
	}
}

func TestStrictJSONPreservesUnicodeWithoutLossySurrogateConversion(t *testing.T) {
	valid := requestJSON(t)
	cases := []struct {
		name, path string
		valid      bool
	}{
		{"chinese_emoji_html", `"目录/😀<&>.txt"`, true},
		{"paired_surrogate", `"input-\ud83d\ude00.txt"`, true},
		{"literal_escape", `"input-\\ud800.txt"`, true},
		{"actual_replacement_character", `"input-�.txt"`, true},
		{"escaped_replacement_character", `"input-\ufffd.txt"`, true},
		{"unpaired_high", `"input-\ud800.txt"`, false},
		{"unpaired_low", `"input-\udfff.txt"`, false},
		{"high_then_ascii", `"input-\ud800\u0061.txt"`, false},
		{"high_then_high", `"input-\ud800\ud800.txt"`, false},
		{"reverse_pair", `"input-\ude00\ud83d.txt"`, false},
		{"invalid_utf8", string([]byte{'"', 0xff, '"'}), false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			raw := strings.Replace(valid, `"input.txt"`, test.path, 1)
			var request effects.EffectRequest
			err := DecodeStrict([]byte(raw), &request)
			if (err == nil) != test.valid {
				t.Fatalf("Unicode validity=%v: %v", test.valid, err)
			}
			if test.valid {
				if err := ValidateRequest(request); err != nil {
					t.Fatal("valid Unicode path rejected", err)
				}
			}
		})
	}
}

func TestStrictResultJSONRequiresCanonicalBase64(t *testing.T) {
	fixture := executionFixture(t)
	raw, err := json.Marshal(fixture.result)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, value string
		valid       bool
	}{
		{"valid", `"aGVsbG8="`, true},
		{"empty_bytes", `""`, true},
		{"explicit_nil", "null", true}, // Negative wire envelopes can carry null; Verify rejects successful null.
		{"numeric_array", "[104,101,108,108,111]", false},
		{"unpadded", `"aGVsbG8"`, false},
		{"newline_alias", `"aGVs\nbG8="`, false},
		{"nonzero_padding_bits", `"Zh=="`, false},
		{"url_alphabet", `"_-8="`, false},
		{"wrong_type", "1", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			modified := strings.Replace(string(raw), `"aGVsbG8="`, test.value, 1)
			var result effects.EffectResult
			if err := DecodeStrict([]byte(modified), &result); (err == nil) != test.valid {
				t.Fatalf("canonical base64 validity=%v: %v", test.valid, err)
			}
		})
	}
}

func TestStrictRegistryJSONRejectsNestedAliasesAndNullScalars(t *testing.T) {
	fixture := executionFixture(t)
	raw, err := json.Marshal(TrustRegistry{Format: TrustRegistryFormat, Keys: fixture.keys})
	if err != nil {
		t.Fatal(err)
	}
	valid := string(raw)
	cases := map[string]string{
		"duplicate_key":     strings.Replace(valid, `"executor_id":"executor:1"`, `"executor_id":"executor:1","executor_id":"executor:1"`, 1),
		"aliased_key_field": strings.Replace(valid, `"public_key"`, `"Public_Key"`, 1),
		"null_bool":         strings.Replace(valid, `"revoked":false`, `"revoked":null`, 1),
		"missing_bool":      strings.Replace(valid, `,"revoked":false`, "", 1),
		"null_keys":         `{"format":"` + TrustRegistryFormat + `","keys":null}`,
	}
	for name, modified := range cases {
		t.Run(name, func(t *testing.T) {
			var registry TrustRegistry
			if err := DecodeStrict([]byte(modified), &registry); err == nil {
				t.Fatal("ambiguous or incomplete trust registry accepted")
			}
		})
	}
	var registry TrustRegistry
	if err := DecodeStrict(raw, &registry); err != nil {
		t.Fatal("valid registry rejected", err)
	}
}

func TestStrictJSONResourceAndDestinationBounds(t *testing.T) {
	var request effects.EffectRequest
	if err := DecodeStrict(bytes.Repeat([]byte{' '}, MaxJSONBytes+1), &request); err == nil {
		t.Fatal("oversized raw JSON accepted")
	}
	deep := strings.Repeat("[", 34) + "0" + strings.Repeat("]", 34)
	if err := DecodeStrict([]byte(deep), &request); err == nil || !strings.Contains(err.Error(), "nesting") {
		t.Fatal("unbounded nested JSON accepted", err)
	}
	for _, destination := range []any{nil, request, (*effects.EffectRequest)(nil)} {
		if err := DecodeStrict([]byte(requestJSON(t)), destination); err == nil {
			t.Fatal("invalid destination accepted")
		}
	}
}
