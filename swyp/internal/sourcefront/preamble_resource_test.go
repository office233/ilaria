package sourcefront

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"text/scanner"
	"unicode/utf8"
)

// Independent oracle: construct the masked prefix separately and concatenate
// the untouched suffix. No call to blankPrefix or ParsePreamble.
func resourceBlankOracle(source string, end int) string {
	if end <= 0 {
		return source
	}
	if end > len(source) {
		end = len(source)
	}
	prefix := bytes.Repeat([]byte{' '}, end)
	for i, value := range []byte(source[:end]) {
		switch value {
		case '\r', '\n':
			prefix[i] = value
		}
	}
	return string(prefix) + source[end:]
}

func TestBlankPrefixResourceByteParity(t *testing.T) {
	sources := []string{"", "abc", "\r\n\n\r", "module α.β;\r\nfn 值() {}", "\x00\xff\xc3\r\n尾"}
	rng := rand.New(rand.NewSource(1))
	for size := 1; size <= 1024; size *= 2 {
		data := make([]byte, size)
		_, _ = rng.Read(data)
		sources = append(sources, string(data))
	}
	for _, source := range sources {
		for end := -1; end <= len(source)+1; end++ {
			got, want := blankPrefix(source, end), resourceBlankOracle(source, end)
			if got != want {
				t.Fatalf("length=%d end=%d: got %q want %q", len(source), end, got, want)
			}
		}
	}
}

func resourceScanFirst(t *testing.T, filename, source string) (string, scanner.Position) {
	t.Helper()
	var s scanner.Scanner
	s.Init(strings.NewReader(source))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanComments | scanner.SkipComments
	s.Error = func(_ *scanner.Scanner, message string) { t.Fatalf("scan: %s", message) }
	if s.Scan() == scanner.EOF {
		return "", s.Pos()
	}
	return s.TokenText(), s.Position
}

func TestPreambleResourceBodyAndPositionParity(t *testing.T) {
	for _, tc := range []struct {
		name, prefix, suffix, token string
	}{
		{"LF", "// header\nmodule app;\nuse lib;", "\n  fn main() {}", "fn"},
		{"CRLF", "// header\r\nmodule app;\r\nuse lib;", "\r\n\tfn main() {}", "fn"},
		{"Unicode", "/* αβ */\nmodule κόσμος.値;\nuse βιβλιοθήκη;", "\n/* 尾 */ 値() {}", "値"},
		{"comments", "/* header */ module app; /* between */ use lib;", " /* body */\n// more\n  type Thing {}", "type"},
		{"same line", "module app; use lib;", " /* body */ fn main() {}", "fn"},
		{"empty", "", "", ""},
		{"legacy", "", "// α\r\nfn main() {}", "fn"},
		{"comments only", "", "/* α */\r\n// end", ""},
		{"EOF", "module app; use lib;", "", ""},
		{"EOF whitespace", "module app;", "\r\n /* tail */", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const filename = "positions.swyp"
			source := tc.prefix + tc.suffix
			_, body, err := ParsePreamble(filename, source)
			if err != nil {
				t.Fatal(err)
			}
			wantBody := resourceBlankOracle(source, len(tc.prefix))
			if body != wantBody {
				t.Fatalf("body bytes: got %q want %q", body, wantBody)
			}
			gotToken, gotPos := resourceScanFirst(t, filename, body)
			wantToken, wantPos := resourceScanFirst(t, filename, wantBody)
			if gotToken != tc.token || gotToken != wantToken || gotPos != wantPos {
				t.Fatalf("token/position: %q %+v, want %q %+v", gotToken, gotPos, wantToken, wantPos)
			}
			if tc.token != "" {
				offset := len(tc.prefix) + strings.Index(tc.suffix, tc.token)
				before := source[:offset]
				lineStart := strings.LastIndex(before, "\n") + 1
				expected := scanner.Position{Filename: filename, Offset: offset,
					Line: strings.Count(before, "\n") + 1, Column: utf8.RuneCountInString(before[lineStart:]) + 1}
				if gotPos != expected {
					t.Fatalf("original position: got %+v want %+v", gotPos, expected)
				}
			}
			first, err := FirstBodyToken(filename, source)
			if err != nil || first != tc.token {
				t.Fatalf("FirstBodyToken=%q err=%v", first, err)
			}
		})
	}
	// Unicode on the same prefix line historically becomes one space per byte,
	// not per rune. Compare to the byte oracle, not a new column interpretation.
	source := "module α; fn main() {}"
	_, body, err := ParsePreamble("unicode-inline.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	_, got := resourceScanFirst(t, "unicode-inline.swyp", body)
	_, want := resourceScanFirst(t, "unicode-inline.swyp", resourceBlankOracle(source, len("module α;")))
	if got != want {
		t.Fatalf("inline Unicode position: got %+v want %+v", got, want)
	}
}

func TestPreambleResourceErrorsAndUsesLimit(t *testing.T) {
	for _, tc := range []struct{ source, message string }{
		{"module a; module b;", "duplicate module"},
		{"use a; module b;", "must precede"},
		{"use a; use a;", "duplicate use"},
		{"module a.;", "expected identifier"},
		{"use ;", "expected identifier"},
		{"module a", "expected \";\""},
		{"use a fn main() {}", "expected \";\""},
	} {
		p, body, err := ParsePreamble("bad.swyp", tc.source)
		var diagnostic *Error
		if !errors.As(err, &diagnostic) || !strings.Contains(err.Error(), tc.message) ||
			diagnostic.Position.Filename != "bad.swyp" || body != "" || !reflect.DeepEqual(p, Preamble{}) {
			t.Fatalf("source=%q preamble=%+v body=%q err=%v", tc.source, p, body, err)
		}
		if _, err := FirstBodyToken("bad.swyp", tc.source); err == nil {
			t.Fatalf("FirstBodyToken accepted %q", tc.source)
		}
	}
	// Preserve the existing split: parsing the preamble does not reject a
	// malformed trailing body comment; FirstBodyToken does scan that body.
	if _, _, err := ParsePreamble("bad.swyp", "module a; /* unterminated"); err != nil {
		t.Fatalf("changed trailing-body behavior: %v", err)
	}
	if _, err := FirstBodyToken("bad.swyp", "module a; /* unterminated"); err == nil || !strings.Contains(err.Error(), "comment not terminated") {
		t.Fatalf("malformed body comment: %v", err)
	}
	var prefix strings.Builder
	for i := 0; i < MaxUses; i++ {
		fmt.Fprintf(&prefix, "use lib.m%d;\n", i)
	}
	source := prefix.String() + "fn main() {}"
	p, body, err := ParsePreamble("limit.swyp", source)
	if err != nil || len(p.Uses) != MaxUses || body != resourceBlankOracle(source, prefix.Len()-1) {
		t.Fatalf("exact MaxUses: uses=%d err=%v", len(p.Uses), err)
	}
	for i, use := range p.Uses {
		if use != fmt.Sprintf("lib.m%d", i) {
			t.Fatalf("use[%d]=%q", i, use)
		}
	}
	_, _, err = ParsePreamble("limit.swyp", prefix.String()+"use lib.extra;\nfn main() {}")
	var diagnostic *Error
	if !errors.As(err, &diagnostic) || !strings.Contains(err.Error(), "use declaration limit exceeded") ||
		diagnostic.Position != (scanner.Position{Filename: "limit.swyp", Offset: prefix.Len(), Line: MaxUses + 1, Column: 1}) {
		t.Fatalf("MaxUses+1: %v", err)
	}
}

func TestBlankPrefixResourceNoPrefixAllocations(t *testing.T) {
	for _, source := range []string{"", "fn main() {}", strings.Repeat("x", 1<<20)} {
		for _, end := range []int{-1, 0} {
			allocs := testing.AllocsPerRun(100, func() { preambleResourceBody = blankPrefix(source, end) })
			if allocs != 0 || preambleResourceBody != source {
				t.Fatalf("end=%d length=%d allocs=%v", end, len(source), allocs)
			}
		}
	}
}
