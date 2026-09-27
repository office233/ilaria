package swyplang

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestStaticChecks(t *testing.T) {
	tests := []struct{ code, want string }{
		{`fn main(){ if false { missing(); } }`, "unknown function"},
		{`fn main(){ print(x); }`, "unknown variable"},
		{`fn main(){ let x=1; x="wrong"; }`, "type mismatch"},
		{`fn main(){ if 1 {} }`, "type mismatch"},
		{`fn main(){ let x=print(1); }`, "type mismatch"},
		{`fn f(x){return x;} fn main(){print(f(1),f("x"));}`, "type mismatch"},
		{`fn f(x){if x>0{return 1;}} fn main(){print(f(1));}`, "without returning"},
		{`fn f(x){return x;} fn main(){}`, "cannot infer"},
		{`fn f(x: bool) -> number {return x;} fn main(){}`, "type mismatch"},
		{`fn main(){print(clock(1));}`, "expects 0 arguments"},
		{`fn main(){print(arg(true));}`, "type mismatch"},
	}
	for _, tt := range tests {
		p, err := Parse("bad.swyp", tt.code)
		if err != nil {
			t.Fatal(err)
		}
		err = p.Check()
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: got %v, want %s", tt.code, err, tt.want)
		}
	}
	for _, src := range []string{sumSource, fibSource, clampSource, `fn identity(x: string) -> string {return x;} fn main(){print(identity("ok"));}`, `fn f(x){return g(x);} fn g(x){if x<1{return 0;}return f(x-1);}fn main(){print(f(4));}`} {
		p, err := Parse("ok.swyp", src)
		if err != nil {
			t.Fatal(err)
		}
		if err = p.Check(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNativeParity(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	tests := []struct{ source, wantError string }{
		{sumSource, ""}, {fibSource, ""}, {clampSource, ""},
		{`fn mark(x:number)->number{print(x);return x;}fn main(){print(mark(1)+mark(2));}`, ""},
		{`fn bomb()->bool{print(99);return true;}fn main(){print(false&&bomb(),true||bomb());}`, ""},
		{`fn main(){let x=1;if true{let x=2;print(x);}print(x);}`, ""},
		{`fn echo(x:string)->string{return x;}fn main(){print(echo("hi\x00there"),"abc"=="abc","a"!="b",1==true);}`, ""},
		{`fn main(){print(1/0);}`, "division by zero"},
		{`fn main(){print(1e308*1e308);}`, "non-finite"},
		{`fn main(){main();}`, "call depth"},
		{`fn main(){print(arg(0),clock()>=0);}`, ""},
		{`fn main(){print(arg(-1));}`, "argument index"},
	}
	for i, tt := range tests {
		p, err := Parse("native.swyp", tt.source)
		if err != nil {
			t.Fatal(err)
		}
		src, err := p.EmitC()
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		input := filepath.Join(dir, "test.c")
		exe := filepath.Join(dir, "test.exe")
		if err = os.WriteFile(input, []byte(src), 0600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(gcc, "-std=c11", "-O2", "-ffp-contract=off", input, "-o", exe, "-lm").CombinedOutput(); err != nil {
			t.Fatalf("case %d compiler: %v %s", i, err, out)
		}
		got, err := exec.Command(exe, "12").CombinedOutput()
		if tt.wantError != "" {
			if err == nil || !strings.Contains(string(got), tt.wantError) {
				t.Fatalf("case %d got %q %v", i, got, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("native: %v %s", err, got)
		}
		var expected bytes.Buffer
		if err = p.RunArgs(&expected, 1_000_000, []float64{12}); err != nil {
			t.Fatal(err)
		}
		if !equivalentOutput(string(got), expected.String()) {
			t.Fatalf("case %d native %q != interpreter %q", i, got, expected.String())
		}
	}
}
func equivalentOutput(a, b string) bool {
	x, y := strings.Fields(a), strings.Fields(b)
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] == y[i] {
			continue
		}
		u, e1 := strconv.ParseFloat(x[i], 64)
		v, e2 := strconv.ParseFloat(y[i], 64)
		if e1 != nil || e2 != nil || u != v {
			return false
		}
	}
	return true
}
func TestNativeUnsupported(t *testing.T) {
	p, err := Parse("concat.swyp", `fn main(){print("a"+"b");}`)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Check(); err != nil {
		t.Fatal(err)
	}
	_, err = p.EmitC()
	if err == nil || !strings.Contains(err.Error(), "string concatenation") {
		t.Fatal(err)
	}
}
