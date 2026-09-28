package swyplang

import (
	"fmt"
	"strconv"
	"strings"
	"text/scanner"
)

// Intent is an explicit source statement. Offsets are UTF-8 byte offsets.
type Intent struct {
	ID    int    `json:"id"`
	Text  string `json:"text"`
	Line  int    `json:"line"`
	Start int    `json:"-"`
	End   int    `json:"-"`
}
type Replacement struct {
	ID   int    `json:"id"`
	Code string `json:"code"`
}

// Intents recognizes directives outside strings and comments. A semicolon is
// mandatory. Normal Swyp syntax is checked after all directives are expanded.
func Intents(filename, source string) ([]Intent, error) {
	if len(source) > 32768 {
		return nil, fmt.Errorf("%s: intent source exceeds 32 KiB", filename)
	}
	var s scanner.Scanner
	s.Init(strings.NewReader(source))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanStrings | scanner.ScanComments | scanner.SkipComments | scanner.ScanInts | scanner.ScanFloats
	var scanErr error
	s.Error = func(s *scanner.Scanner, message string) {
		if scanErr == nil {
			scanErr = failure(s.Position, "%s", message)
		}
	}
	var intents []Intent
	for tok := s.Scan(); tok != scanner.EOF; tok = s.Scan() {
		if tok != '#' {
			continue
		}
		pos := s.Position
		if s.Scan() != scanner.Ident {
			return nil, failure(pos, "expected #natural or #limbaj_natural")
		}
		name := s.TokenText()
		if name != "natural" && name != "limbaj_natural" {
			return nil, failure(pos, "unknown intent directive #%s", name)
		}
		if s.Scan() != ':' {
			return nil, failure(pos, "expected ':' after intent directive")
		}
		if s.Scan() != scanner.String {
			return nil, failure(pos, "intent must be a double-quoted string")
		}
		value, err := strconv.Unquote(s.TokenText())
		if err != nil {
			return nil, failure(pos, "invalid intent string")
		}
		if strings.TrimSpace(value) == "" {
			return nil, failure(pos, "intent cannot be empty")
		}
		if s.Scan() != ';' {
			return nil, failure(pos, "expected ';' after intent")
		}
		intents = append(intents, Intent{ID: len(intents), Text: value, Line: pos.Line, Start: pos.Offset, End: s.Position.Offset + 1})
	}
	if scanErr != nil {
		return nil, scanErr
	}
	return intents, nil
}

// Expand replaces only directive spans. Model output cannot rewrite ordinary
// source outside those spans. Each replacement must parse as statements.
func Expand(filename, source string, replacements []Replacement) (string, error) {
	intents, err := Intents(filename, source)
	if err != nil {
		return "", err
	}
	if len(intents) == 0 {
		return "", fmt.Errorf("no intent directives found")
	}
	if len(replacements) != len(intents) {
		return "", fmt.Errorf("expected %d replacements, got %d", len(intents), len(replacements))
	}
	byID := map[int]string{}
	for _, r := range replacements {
		if r.ID < 0 || r.ID >= len(intents) {
			return "", fmt.Errorf("unknown replacement ID %d", r.ID)
		}
		if _, ok := byID[r.ID]; ok {
			return "", fmt.Errorf("duplicate replacement ID %d", r.ID)
		}
		if strings.TrimSpace(r.Code) == "" {
			return "", fmt.Errorf("replacement %d is empty", r.ID)
		}
		fragment, err := Parse("intent-fragment.swyp", "fn main() {\n"+r.Code+"\n}")
		if err != nil {
			return "", fmt.Errorf("replacement %d must contain Swyp statements: %w", r.ID, err)
		}
		if len(fragment.functions) != 1 {
			return "", fmt.Errorf("replacement %d escapes its statement scope", r.ID)
		}
		byID[r.ID] = r.Code
	}
	var b strings.Builder
	offset := 0
	for _, intent := range intents {
		b.WriteString(source[offset:intent.Start])
		fmt.Fprintf(&b, "// Expanded intent %d (original line %d)\n%s\n", intent.ID, intent.Line, byID[intent.ID])
		offset = intent.End
	}
	b.WriteString(source[offset:])
	expanded := b.String()
	p, err := Parse(filename+".expanded", expanded)
	if err != nil {
		return "", err
	}
	if err = p.Check(); err != nil {
		return "", err
	}
	return expanded, nil
}
