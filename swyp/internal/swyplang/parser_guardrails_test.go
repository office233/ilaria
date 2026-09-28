package swyplang

import (
	"bytes"
	"fmt"
	"math"
	"strings"
	"testing"
)

// Numeric-looking identifiers must not become non-finite float64 literals.
func TestParserFiniteNumberIdentifiers(t *testing.T) {
	for _, name := range []string{"NaN", "nan", "NAN", "Inf", "Infinity"} {
		t.Run(name, func(t *testing.T) {
			source := fmt.Sprintf("fn main() { let %s = 7; print(%s); }", name, name)
			p, err := Parse("identifier.swyp", source)
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Check(); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			if err := p.Run(&output, 100); err != nil {
				t.Fatal(err)
			}
			if got := output.String(); got != "7\n" {
				t.Fatalf("identifier %s evaluated to %q, want 7", name, got)
			}
		})
	}
}

func TestParserUnboundNonFiniteNames(t *testing.T) {
	for _, name := range []string{"NaN", "nan", "NAN", "Inf", "Infinity"} {
		t.Run(name, func(t *testing.T) {
			p, err := Parse("unbound.swyp", "fn main() { print("+name+"); }")
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Check(); err == nil || !strings.Contains(err.Error(), "unknown variable") {
				t.Fatalf("unbound %s passed finite-number checking: %v", name, err)
			}
			var output bytes.Buffer
			if err := p.Run(&output, 100); err == nil || !strings.Contains(err.Error(), "unknown variable") {
				t.Fatalf("dynamic execution accepted %s: output=%q error=%v", name, output.String(), err)
			}
		})
	}
}

func TestParserNonFiniteFunctionName(t *testing.T) {
	p, err := Parse("function.swyp", "fn NaN() -> number { return 9; } fn main() { print(NaN()); }")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := p.Run(&output, 100); err != nil {
		t.Fatal(err)
	}
	if output.String() != "9\n" {
		t.Fatalf("got %q, want 9", output.String())
	}
}

func TestParserNumericLiteralsRemainFinite(t *testing.T) {
	for _, literal := range []string{"0", "1.5", "1e-10", "1_000", "0x1p2", "1.7976931348623157e308"} {
		t.Run(literal, func(t *testing.T) {
			p, err := Parse("finite.swyp", "fn main() { return "+literal+"; }")
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Check(); err != nil {
				t.Fatal(err)
			}
			value, ok := p.functions["main"].body[0].value.value.(float64)
			if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
				t.Fatalf("literal %s is not a finite number: %v", literal, value)
			}
		})
	}
	if p, err := Parse("overflow.swyp", "fn main() { return 1e309; }"); err == nil || p != nil {
		t.Fatalf("accepted overflowing numeric literal: program=%v error=%v", p, err)
	}
}

func TestParserRejectsDeepExpressionTrees(t *testing.T) {
	for _, tc := range []struct{ name, expression string }{
		{"addition", "1" + strings.Repeat(" + 1", 512)},
		{"boolean", "true" + strings.Repeat(" && true", 512)},
		{"mixed", "1" + strings.Repeat(" + 2 * 3", 512)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := Parse("deep.swyp", "fn main() { return "+tc.expression+"; }")
			if err == nil || !strings.Contains(err.Error(), "nesting limit") || p != nil {
				t.Fatalf("deep AST bypassed the nesting guard: program=%v error=%v", p != nil, err)
			}
		})
	}
}

func TestParserAcceptsShallowExpressionTrees(t *testing.T) {
	source := "fn main() { print(1" + strings.Repeat(" + 1", 63) + "); }"
	p, err := Parse("shallow.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := p.Run(&output, 1000); err != nil {
		t.Fatal(err)
	}
	if output.String() != "64\n" {
		t.Fatalf("got %q, want 64", output.String())
	}
}

func TestCoreTailExpressionIsFunctionResult(t *testing.T) {
	accepted := []string{
		"fn sq(x: i64) -> i64 { x * x }\nfn main() {}",
		"fn ab(x: i64) -> i64 { if x < 0 { -x } else { x } }\nfn main() {}",
		"fn s(n: i64) -> i64 { if n == 0 { 0 } else { if n > 100 { return 0; } s(n - 1) + n } }\nfn main() {}",
		"fn sum(n: i64) -> i64 {\n  let t: i64 = 0;\n  let i: i64 = 1;\n  while i <= n { t = t + i; i = i + 1; }\n  t\n}\nfn main() {}",
	}
	for _, src := range accepted {
		if _, err := ParseCore("tail.swyp", src); err != nil {
			t.Fatalf("core rejected tail expression: %v\n%s", err, src)
		}
	}
	rejected := map[string]string{
		"legacy language":       "fn sq(x) -> number { x * x }\nfn main() {}",
		"nested block tail":     "fn sq(x: i64) -> i64 { if x < 0 { x } return x; }\nfn main() {}",
		"function without type": "fn f(x: i64) { x * x }\nfn main() {}",
		"main":                  "fn main() { 1 + 1 }",
		"if without else":       "fn f(x: i64) -> i64 { if x < 0 { x } }\nfn main() {}",
		"if/else not final":     "fn f(x: i64) -> i64 { if x < 0 { x } else { 0 } return 1; }\nfn main() {}",
		"tail inside while":     "fn f(x: i64) -> i64 { while x < 0 { x } }\nfn main() {}",
	}
	for name, src := range rejected {
		parse := ParseCore
		if name == "legacy language" {
			parse = Parse
		}
		if _, err := parse("tail.swyp", src); err == nil {
			t.Fatalf("%s: accepted %q", name, src)
		}
	}
}
