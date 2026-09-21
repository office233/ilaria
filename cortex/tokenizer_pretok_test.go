package cortex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Pre-tokenizer v2 (2026-09-21): the space marker Ġ is attached only to a
// pre-token that actually follows whitespace. Before, every token after a
// punctuation mark got Ġ, so "după-amiază" decoded as "după- amiază" and the
// Romanian quote „citat” as „ citat”. Old tokenizers (no "pretok" field in
// their JSON) keep the legacy split so trained brains still see the same ids.

func TestPreTokenizeV2_NoSpaceMarkerAfterPunctuationWithoutSpace(t *testing.T) {
	cases := map[string][]string{
		"după-amiază":   {"după", "-", "amiază"},
		"Hello world!":  {"Hello", "Ġworld", "!"},
		"a „b” c":       {"a", "Ġ„", "b", "”", "Ġc"},
		"x , y":         {"x", "Ġ,", "Ġy"},
		"e.g. (test)":   {"e", ".", "g", ".", "Ġ(", "test", ")"},
		"  leading":     {"leading"},
		"1457 și 1504.": {"1457", "Ġși", "Ġ1504", "."},
	}
	for in, want := range cases {
		if got := PreTokenize(in); !reflect.DeepEqual(got, want) {
			t.Errorf("PreTokenize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPreTokenizeLegacy_KeepsOldBehaviour(t *testing.T) {
	if got, want := PreTokenizeLegacy("după-amiază"), []string{"după", "-", "Ġamiază"}; !reflect.DeepEqual(got, want) {
		t.Errorf("legacy = %q, want %q", got, want)
	}
}

func TestTokenizerV2_RoundTripsRomanianPunctuation(t *testing.T) {
	tok := NewBPETokenizer(400)
	tok.Train([]string{
		"după-amiază copiii citesc „cărți” bune (foarte bune).",
		"În această după-amiază, copiii învață să citească.",
		"Felul în care vedem „căderea Antichității” și instalarea Evului Mediu.",
	})
	if tok.PreTok != 2 {
		t.Fatalf("freshly trained tokenizer must be v2, got %d", tok.PreTok)
	}
	for _, s := range []string{"după-amiază", "„căderea Antichității”", "a, b (c) d."} {
		if back := tok.Decode(tok.Encode(s)); back != s {
			t.Errorf("roundtrip %q → %q", s, back)
		}
	}
	// Save/Load keeps the version.
	path := filepath.Join(t.TempDir(), "tok.json")
	if err := tok.Save(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadBPETokenizer(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.PreTok != 2 {
		t.Fatalf("loaded version = %d, want 2", loaded.PreTok)
	}
	if back := loaded.Decode(loaded.Encode("după-amiază")); back != "după-amiază" {
		t.Errorf("loaded roundtrip → %q", back)
	}
}

func TestTokenizerLegacyJSON_LoadsAsV0AndSplitsTheOldWay(t *testing.T) {
	tok := NewBPETokenizer(400)
	tok.Train([]string{"după-amiază copiii citesc"})
	path := filepath.Join(t.TempDir(), "old.json")
	if err := tok.Save(path); err != nil {
		t.Fatal(err)
	}
	// Strip the version field to simulate a tokenizer saved before v2.
	raw, _ := os.ReadFile(path)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "pretok")
	raw, _ = json.Marshal(m)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	old, err := LoadBPETokenizer(path)
	if err != nil {
		t.Fatal(err)
	}
	if old.PreTok != 0 {
		t.Fatalf("legacy file must load as v0, got %d", old.PreTok)
	}
	if back := old.Decode(old.Encode("după-amiază")); back != "după- amiază" {
		t.Errorf("legacy tokenizer must keep its old (buggy) split for compatibility, got %q", back)
	}
}
