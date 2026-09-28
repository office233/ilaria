package swyplang

import (
	"bytes"
	"strings"
	"testing"
)

func TestPrograms(t *testing.T) {
	tests := []struct{ name, code, want string }{
		{"precedence", `fn main() { print(2 + 3 * 4, (2 + 3) * 4, -2 * 3); }`, "14 20 -6\n"},
		{"recursion", `fn fib(n) { if n <= 1 { return n; } return fib(n-1) + fib(n-2); } fn main() { print(fib(10)); }`, "55\n"},
		{"scope", `fn main() { let x = 1; if true { let x = 9; print(x); } while x < 3 { x = x + 1; } print(x); }`, "9\n3\n"},
		{"short circuit", `fn main() { print(false && missing(), true || missing()); }`, "false true\n"},
		{"strings", `fn main() { print("Swyp" + " Lang", "line\nend"); }`, "Swyp Lang line\nend\n"},
		{"comparison", `fn main() { print(3 >= 3, 2 != 3, 2 == 2, !false, 7 % 3, 5 / 2); }`, "true true true true 1 2.5\n"},
		{"return loop", `fn f() { while true { if true { return 7; } } } fn main() { print(f()); }`, "7\n"},
		{"unicode", `fn main() { let număr = 3; print(număr); }`, "3\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Parse("test.swyp", tt.code)
			if err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err = p.Run(&out, 100000); err != nil {
				t.Fatal(err)
			}
			if out.String() != tt.want {
				t.Fatalf("got %q want %q", out.String(), tt.want)
			}
		})
	}
}
func TestParseErrors(t *testing.T) {
	tests := []struct{ code, want string }{
		{`fn main() { let x = 1 }`, "expected \";\""},
		{`fn main() {`, "closing brace"},
		{`fn foo() {}`, "missing fn main"},
		{`fn main(x) {}`, "no parameters"},
		{`fn main() {} fn main() {}`, "duplicate function"},
		{`fn f(x,x) {} fn main() {}`, "duplicate parameter"},
		{`fn main() { print("oops); }`, "literal not terminated"},
		{`fn main() { let if = 1; }`, "reserved word"},
		{`fn main() { print(1 < = 2); }`, "expected identifier"},
		{`fn main() { print(` + strings.Repeat("(", 300) + `1); }`, "nesting limit"},
	}
	for _, tt := range tests {
		_, err := Parse("bad.swyp", tt.code)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: got %v, want %s", tt.code, err, tt.want)
		}
	}
}
func TestRuntimeErrors(t *testing.T) {
	tests := []struct{ code, want string }{
		{`fn main() { print(1/0); }`, "division by zero"},
		{`fn main() { print(1%0); }`, "remainder by zero"},
		{`fn main() { print(x); }`, "unknown variable"},
		{`fn main() { x = 2; }`, "unknown variable"},
		{`fn main() { missing(); }`, "unknown function"},
		{`fn f(x) {} fn main() { f(); }`, "expects 1 arguments"},
		{`fn main() { if 1 {} }`, "expected boolean"},
		{`fn main() { print("a"-1); }`, "expected number"},
		{`fn main() { let x=1; let x=2; }`, "duplicate variable"},
		{`fn main() { while true {} }`, "step limit"},
		{`fn main() { main(); }`, "depth limit"},
		{`fn main() { print(1e308 * 1e308); }`, "non-finite"},
	}
	for _, tt := range tests {
		p, err := Parse("runtime.swyp", tt.code)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		err = p.Run(&out, 1000)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: got %v, want %s", tt.code, err, tt.want)
		}
	}
}
func FuzzParse(f *testing.F) {
	f.Add(`fn main() { print(42); }`)
	f.Add(`fn main() {`)
	f.Fuzz(func(t *testing.T, source string) { _, _ = Parse("fuzz.swyp", source) })
}
