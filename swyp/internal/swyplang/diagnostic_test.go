package swyplang

import (
	"errors"
	"strings"
	"testing"
)

func requireSourceDiagnostic(t *testing.T, err error, code string) *Diagnostic {
	t.Helper()
	if err == nil {
		t.Fatalf("expected diagnostic %q", code)
	}
	var d *Diagnostic
	if !errors.As(err, &d) {
		t.Fatalf("error %T is not a source diagnostic: %v", err, err)
	}
	if d.Code != code {
		t.Fatalf("diagnostic code=%q want=%q error=%v", d.Code, code, err)
	}
	return d
}

func TestParseDiagnosticCodesAreStableAndLocated(t *testing.T) {
	cases := []struct {
		name   string
		source string
		code   string
	}{
		{"missing main", `fn helper() {}`, DiagnosticMissingMain},
		{"duplicate function", `fn main() {} fn main() {}`, DiagnosticDuplicateFunction},
		{"reserved identifier", `fn main() { let if = 1; }`, DiagnosticReservedIdentifier},
		{"unexpected token", `fn main() { let x = 1 }`, DiagnosticUnexpectedToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse("candidate.swyp", tc.source)
			d := requireSourceDiagnostic(t, err, tc.code)
			if d.Location.File != "candidate.swyp" || d.Location.Line <= 0 || d.Location.Column <= 0 {
				t.Fatalf("invalid location: %+v", d.Location)
			}
			if strings.Contains(err.Error(), tc.code) {
				t.Fatalf("human-readable error unexpectedly embeds stable code: %q", err)
			}
			if !strings.HasPrefix(err.Error(), "candidate.swyp:") {
				t.Fatalf("legacy location prefix lost: %q", err)
			}
		})
	}
}

func TestCheckDiagnosticCodesAreStable(t *testing.T) {
	cases := []struct {
		name   string
		source string
		code   string
	}{
		{"unknown variable", `fn main() { print(x); }`, DiagnosticUnknownVariable},
		{"type mismatch", `fn main() { let x = 1; x = "wrong"; }`, DiagnosticTypeMismatch},
		{"duplicate variable", `fn main() { let x = 1; let x = 2; }`, DiagnosticDuplicateVariable},
		{"unknown function", `fn main() { missing(); }`, DiagnosticUnknownFunction},
		{"arity mismatch", `fn f(x: number) {} fn main() { f(); }`, DiagnosticArityMismatch},
		{"cannot infer", `fn f(x) { return x; } fn main() {}`, DiagnosticCannotInferType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, err := Parse("candidate.swyp", tc.source)
			if err != nil {
				t.Fatal(err)
			}
			requireSourceDiagnostic(t, p.Check(), tc.code)
		})
	}
}

func TestCanonicalDiagnosticCodesAreUnique(t *testing.T) {
	codes := CanonicalDiagnosticCodes()
	if DiagnosticSchemaVersion != 1 || len(codes) < 10 {
		t.Fatalf("diagnostic contract version=%d codes=%v", DiagnosticSchemaVersion, codes)
	}
	seen := make(map[string]bool, len(codes))
	for _, code := range codes {
		if code == "" || seen[code] {
			t.Fatalf("invalid canonical diagnostic code %q in %v", code, codes)
		}
		seen[code] = true
	}
	copyCodes := CanonicalDiagnosticCodes()
	copyCodes[0] = "mutated"
	if CanonicalDiagnosticCodes()[0] == "mutated" {
		t.Fatal("canonical diagnostic code registry leaked mutable storage")
	}
}

func TestSharedModulePreambleOnExecutableSource(t *testing.T) {
	source := "module app.main;\nuse platform.math;\nuse platform.types;\nfn main() { print(1); }\n"
	p, err := Parse("app.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if p.ModuleName() != "app.main" || strings.Join(p.Uses(), ",") != "platform.math,platform.types" {
		t.Fatalf("module=%q uses=%v", p.ModuleName(), p.Uses())
	}
	uses := p.Uses()
	uses[0] = "mutated"
	if p.Uses()[0] == "mutated" {
		t.Fatal("Program.Uses leaked mutable storage")
	}
	_, err = Parse("bad.swyp", "use a; use a; fn main() {}")
	requireSourceDiagnostic(t, err, DiagnosticModulePreamble)

	_, err = Parse("lexical.swyp", "module app.main;\n/* unterminated")
	requireSourceDiagnostic(t, err, DiagnosticLexicalError)
}
