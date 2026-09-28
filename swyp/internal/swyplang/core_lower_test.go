package swyplang

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func coreCompileTest(t *testing.T, source, entry string) *coreir.Executable {
	t.Helper()
	p, err := ParseCore("core-test.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		t.Fatal(err)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func TestCoreSourceNumericAndControlFlow(t *testing.T) {
	cases := []struct {
		name, source, input, want string
		typ                       coreir.Type
	}{
		{"exact input", `fn f(x:i64)->i64{return x+1;} fn main(){}`, "9007199254740993", "9007199254740994", coreir.I64},
		{"exact literal", `fn f(x:i64)->i64{return 9007199254740993;} fn main(){}`, "0", "9007199254740993", coreir.I64},
		{"minimum", `fn f(x:i64)->i64{return -9223372036854775808;} fn main(){}`, "0", "-9223372036854775808", coreir.I64},
		{"integer division", `fn f(x:i64)->i64{return x/3;} fn main(){}`, "-7", "-2", coreir.I64},
		{"integer remainder", `fn f(x:i64)->i64{return x%3;} fn main(){}`, "-7", "-1", coreir.I64},
		{"loop", `fn f(x:i64)->i64{let i:i64=0;let y:i64=0;while i<x {y=y+i;i=i+1;}return y;} fn main(){}`, "10", "45", coreir.I64},
		{"shadow", `fn f(x:i64)->i64{let y:i64=x;if x>0 {let y:i64=y+1;y=y*2;}return y;} fn main(){}`, "9", "9", coreir.I64},
		{"calls", `fn square(x:i64)->i64{return x*x;} fn f(x:i64)->i64{return square(x)+square(x+1);} fn main(){}`, "3", "25", coreir.I64},
		{"short and", `fn f(x:i64)->bool{return x!=0 && 10/x>0;} fn main(){}`, "0", "false", coreir.I64},
		{"short or", `fn f(x:i64)->bool{return x==0 || 10/x>0;} fn main(){}`, "0", "true", coreir.I64},
		{"nested bool", `fn f(x:i64)->bool{return (x==0 || 10/x>0) && !(x<0);} fn main(){}`, "0", "true", coreir.I64},
		{"early returns", `fn f(x:i64)->i64{if x<0 {return -x;}else{return x;}} fn main(){}`, "-9", "9", coreir.I64},
		{"f64 division", `fn f(x:f64)->f64{return x/2;} fn main(){}`, "5", "2.5", coreir.F64},
		{"legacy number", `fn f(x:number)->number{return x/2;} fn main(){print(f(arg(0)));}`, "5", "2.5", coreir.F64},
		{"negative zero", `fn f(x:f64)->f64{return -0;} fn main(){}`, "1", "-0", coreir.F64},
		{"cross type equality", `fn f(x:number)->bool{return x==true;} fn main(){}`, "1", "false", coreir.F64},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := coreCompileTest(t, c.source, "f")
			x, err := coreir.ParseValue(c.typ, c.input)
			if err != nil {
				t.Fatal(err)
			}
			r, err := e.Run(context.Background(), "f", []coreir.Value{x}, 10000)
			if err != nil || r.Value.Literal().Value != c.want {
				t.Fatalf("got %v %v, want %s", r, err, c.want)
			}
		})
	}
}
func TestCoreSourceRejectsInvalidAndImpure(t *testing.T) {
	for _, source := range []string{
		`fn f(x:i64)->i64{return x+1.5;} fn main(){}`,
		`fn f(x:i64)->i64{let y=1;return x+y;} fn main(){}`,
		`fn f(x:i64)->i64{return 9223372036854775808;} fn main(){}`,
		`fn f(x:i64)->i64{if x>0{return x;}} fn main(){}`,
		`fn f(x:i64)->i64{return x;let y=missing;} fn main(){}`,
		`fn f(x:i64)->i64{return x;clock();} fn main(){}`,
		`fn g()->number{return clock();} fn f(x:i64)->i64{g();return x;} fn main(){}`,
		`fn f(x:i64)->i64{print(x);return x;} fn main(){}`,
		`fn f(x)->number{return x;} fn main(){}`,
		`fn f(x:i64)->i64{if x>0{let y:i64=1;}return y;} fn main(){}`,
	} {
		p, err := ParseCore("invalid.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = p.CoreIR("f"); err == nil {
			t.Fatalf("accepted %s", source)
		}
	}
}
func TestCoreSourceRetainsRuntimeErrorsAndIsolation(t *testing.T) {
	for _, body := range []string{`return (x+1)-1;`, `return -x;`, `return x/-1;`} {
		e := coreCompileTest(t, `fn f(x:i64)->i64{`+body+`} fn main(){}`, "f")
		input := int64(-1 << 63)
		if strings.Contains(body, "x+1") {
			input = 1<<63 - 1
		}
		if _, err := e.Run(context.Background(), "f", []coreir.Value{coreir.Int(input)}, 100); err == nil {
			t.Fatal("lost intermediate trap", body)
		}
	}
	e := coreCompileTest(t, `fn f(x:i64)->i64{return f(x);} fn main(){}`, "f")
	if _, err := e.Run(context.Background(), "f", []coreir.Value{coreir.Int(1)}, 10000); err == nil || !strings.Contains(err.Error(), "call_depth") {
		t.Fatal(err)
	}
	p, err := ParseCore("isolation.swyp", `fn main()->i64{return 1;}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err == nil {
		t.Fatal("legacy checker accepted core mode")
	}
	if err := p.Run(io.Discard, 100); err == nil {
		t.Fatal("legacy interpreter accepted core mode")
	}
	if _, err := p.EmitC(); err == nil {
		t.Fatal("legacy C emitter accepted core mode")
	}
	if _, err := p.CompileSTV2(); err == nil {
		t.Fatal("STV2 accepted core mode")
	}
	if _, err := p.EmitHTML(); err == nil {
		t.Fatal("legacy JS emitter accepted core mode")
	}
	if _, err := Parse("legacy.swyp", `fn main()->i64{return 1;}`); err == nil {
		t.Fatal("legacy syntax silently extended")
	}
}
func TestCoreDifferential10000(t *testing.T) {
	seen := map[string]bool{}
	inputs := []int64{-3, 0, 7}
	for k := 0; k < 10000; k++ {
		body := fmt.Sprintf(`let y=x+%d;if x<0{y=y*2;}else{y=y-3;}let i=0;while i<%d{y=y+x;i=i+1;}return y;`, k, k%5)
		source := `fn kernel(x:number)->number{` + body + `} fn main(){print(kernel(arg(0)));}`
		if seen[source] {
			t.Fatal("duplicate generated source")
		}
		seen[source] = true
		p, err := Parse("corpus.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Check(); err != nil {
			t.Fatal(err)
		}
		m, err := p.CoreIR("kernel")
		if err != nil {
			t.Fatalf("%d: %v", k, err)
		}
		e, err := coreir.Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		if k < 50 {
			m2, err := p.CoreIR("kernel")
			if err != nil {
				t.Fatal(err)
			}
			a, _ := json.Marshal(m)
			b, _ := json.Marshal(m2)
			if !bytes.Equal(a, b) {
				t.Fatal("nondeterministic lowering")
			}
		}
		sp, err := Parse("stv2-corpus.swyp", `fn main()->number{let x=arg(0);`+body+`}`)
		if err != nil {
			t.Fatal(err)
		}
		sm, err := sp.CompileSTV2()
		if err != nil {
			t.Fatalf("STV2 %d: %v", k, err)
		}
		for _, x := range inputs {
			want := x + int64(k)
			if x < 0 {
				want *= 2
			} else {
				want -= 3
			}
			want += x * int64(k%5)
			cv, _ := coreir.ParseValue(coreir.F64, strconv.FormatInt(x, 10))
			r, err := e.Run(context.Background(), "kernel", []coreir.Value{cv}, 1000)
			fv, ok := r.Value.Float64()
			if err != nil || !ok || fv != float64(want) {
				t.Fatalf("core k=%d x=%d: %v %v want %d", k, x, r, err, want)
			}
			var output bytes.Buffer
			if err := p.RunArgs(&output, 1000, []float64{float64(x)}); err != nil {
				t.Fatal(err)
			}
			av, err := strconv.ParseFloat(strings.TrimSpace(output.String()), 64)
			if err != nil || av != float64(want) {
				t.Fatalf("AST %d: %s", k, output.String())
			}
			sv, err := sm.Run([]int64{x}, 1000)
			if err != nil || sv.Value != want {
				t.Fatalf("STV2 %d: %v %v", k, sv, err)
			}
		}
	}
	t.Logf("%d distinct programs; %d input cases; core/AST/STV2 compared with independent integer oracle", len(seen), len(seen)*len(inputs))
}
func FuzzCoreLower(f *testing.F) {
	f.Add(`fn main()->i64{return 9007199254740993;}`)
	f.Add(`fn main()->bool{return false && 1/0>0;}`)
	f.Fuzz(func(t *testing.T, source string) {
		p, err := ParseCore("fuzz.swyp", source)
		if err != nil {
			return
		}
		m, err := p.CoreIR("main")
		if err != nil {
			return
		}
		e, err := coreir.Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = e.Run(context.Background(), "main", nil, 128)
	})
}
