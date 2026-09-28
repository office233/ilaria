package swyplang

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"math/rand"
	"strings"
	"sync"
	"testing"
	"text/scanner"

	vm "swyp-lang/internal/stv2"
)

const stv2SumSwyp = `fn main() -> number {
    let n = arg(0);
    let total = 0;
    while n > 0 {
        total = total + n;
        n = n - 1;
    }
    return total;
}`

// Same parsed source, independent execution engine. No text-output conversion.
func stv2Reference(p *Program, args []int64) (v any, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				panic(r)
			}
		}
	}()
	fargs := make([]float64, len(args))
	for i, a := range args {
		fargs[i] = float64(a)
	}
	r := &runtime{program: p, out: io.Discard, steps: 1000000, args: fargs}
	return r.call("main", nil, scanner.Position{Filename: "reference"}), nil
}
func stv2CompileTest(t testing.TB, s string) (*Program, *STV2Module) {
	t.Helper()
	p, e := Parse("test.swyp", s)
	if e != nil {
		t.Fatal(e)
	}
	m, e := p.CompileSTV2()
	if e != nil {
		t.Fatalf("%s\n%v", s, e)
	}
	return p, m
}
func stv2CompareTest(t testing.TB, p *Program, m *STV2Module, args []int64) {
	t.Helper()
	want, e := stv2Reference(p, args)
	if e != nil {
		t.Fatal(e)
	}
	got, e := m.Run(args, vm.MaxFuel)
	if e != nil {
		t.Fatal(e)
	}
	switch w := want.(type) {
	case float64:
		if float64(got.Value) != w || m.ResultType() != "number" {
			t.Fatal(args, got.Value, w, m.ResultType())
		}
	case bool:
		if (got.Value == 1) != w || (got.Value != 0 && got.Value != 1) || m.ResultType() != "bool" {
			t.Fatal(args, got.Value, w, m.ResultType())
		}
	default:
		t.Fatalf("unexpected reference type %T", want)
	}
}

func TestSTV2LoweredLoopsAndScopes(t *testing.T) {
	programs := []string{
		stv2SumSwyp,
		`fn main()->number {let n=arg(0);let a=0;let b=1;while n>0 {let next=a+b;a=b;b=next;n=n-1;} return a;}`,
		`fn main()->number {let x=arg(0);if x>=0 {let x=x+10;x=x*2;} else {x=-x;}return x+arg(0);}`,
		`fn main()->number {let n=arg(0);let s=0;while n>0 {if n%2==0{s=s+n;}else{let d=n-1;s=s+d;}n=n-1;}return s;}`,
		`fn main()->number {let n=arg(0);let s=0;while n>0 {let k=3;while k>0{s=s+n;k=k-1;}n=n-1;}return s;}`,
		`fn main()->number {if arg(0)<0{return -7;}else{if arg(0)==0{return 42;}else{return 9;}}}`,
		`fn main()->number {let x=arg(0);x=x+1;return x+arg(0);}`,
		`fn main()->number {while arg(0)>0{return 1;}return 0;}`,
	}
	for i, s := range programs {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			p, m := stv2CompileTest(t, s)
			for n := int64(-5); n <= 40; n++ {
				stv2CompareTest(t, p, m, []int64{n})
			}
		})
	}
	p, m := stv2CompileTest(t, stv2SumSwyp)
	for n := int64(0); n <= 1000; n++ {
		stv2CompareTest(t, p, m, []int64{n})
	}
	t.Log("loop/scope comparisons=1369")
}

func stv2RandomNumber(r *rand.Rand, depth int) string {
	if depth == 0 {
		switch r.Intn(4) {
		case 0:
			return "arg(0)"
		case 1:
			return "arg(1)"
		default:
			return fmt.Sprint(r.Intn(11) - 5)
		}
	}
	if r.Intn(5) == 0 {
		return "(-" + stv2RandomNumber(r, depth-1) + ")"
	}
	ops := []string{"+", "-", "*", "%"}
	op := ops[r.Intn(len(ops))]
	left, right := stv2RandomNumber(r, depth-1), stv2RandomNumber(r, depth-1)
	if op == "%" {
		right = fmt.Sprint(r.Intn(9) + 1)
	}
	return "(" + left + op + right + ")"
}
func stv2RandomBool(r *rand.Rand, depth int) string {
	if depth == 0 {
		ops := []string{"==", "!=", "<", "<=", ">", ">="}
		return "(" + stv2RandomNumber(r, 1) + ops[r.Intn(6)] + stv2RandomNumber(r, 1) + ")"
	}
	if r.Intn(3) == 0 {
		return "(!" + stv2RandomBool(r, depth-1) + ")"
	}
	ops := []string{"&&", "||"}
	return "(" + stv2RandomBool(r, depth-1) + ops[r.Intn(2)] + stv2RandomBool(r, depth-1) + ")"
}
func TestSTV2GeneratedDifferential(t *testing.T) {
	r := rand.New(rand.NewSource(15802))
	count := 0
	for i := 0; i < 5000; i++ {
		expression := stv2RandomNumber(r, 3)
		kind := "number"
		if i%2 == 0 {
			expression = stv2RandomBool(r, 2)
			kind = "bool"
		}
		s := "fn main()->" + kind + "{return " + expression + ";}"
		p, m := stv2CompileTest(t, s)
		for j := 0; j < 4; j++ {
			args := make([]int64, m.ArgumentCount())
			for k := range args {
				args[k] = int64(r.Intn(41) - 20)
			}
			stv2CompareTest(t, p, m, args)
			count++
		}
		again, e := p.CompileSTV2()
		if e != nil || !bytes.Equal(m.Bytecode(), again.Bytecode()) {
			t.Fatal("nondeterministic compilation", i, e)
		}
	}
	t.Logf("generated programs=5000 differential executions=%d seed=15802", count)
}

func TestSTV2ShortCircuitAndCrossTypeEquality(t *testing.T) {
	for _, expr := range []string{"false && (1%0==0)", "true || (1%0==0)", "true==1", "false==0", "false!=0", "1!=true", "!false", "!!true", "(true==false)==false"} {
		p, m := stv2CompileTest(t, "fn main()->bool{return "+expr+";}")
		stv2CompareTest(t, p, m, nil)
	}
	for _, expr := range []string{"true && (1%0==0)", "false || (1%0==0)", "true==(1%0)", "(1%0)!=false"} {
		p, m := stv2CompileTest(t, "fn main()->bool{return "+expr+";}")
		if _, e := stv2Reference(p, nil); e == nil {
			t.Fatal("reference must evaluate RHS")
		}
		if _, e := m.Run(nil, 100); e == nil {
			t.Fatal("compiled must evaluate RHS")
		}
	}
}

func TestSTV2CompileRejectsUnsupported(t *testing.T) {
	bad := []string{
		`fn main(){print(1);}`,
		`fn main()->number{return 3/2;}`,
		`fn main()->number{if false{return 3/2;}return 1;}`,
		`fn main()->number{return 1.25;}`,
		`fn main()->number{return 2147483648;}`,
		`fn main()->number{return -2147483649;}`,
		`fn main()->string{return "x";}`,
		`fn main()->number{let x="unused";return 1;}`,
		`fn main()->number{return clock();}`,
		`fn f()->number{return 1;}fn main()->number{return f();}`,
		`fn main()->number{return arg(4);}`,
		`fn main()->number{return arg(-1);}`,
		`fn main()->number{return arg(1.5);}`,
		`fn main()->number{let i=0;return arg(i);}`,
		`fn main()->number{let a=0;let b=0;let c=0;let d=0;let e=0;let f=0;let g=0;let h=0;return a+b;}`,
		`fn main()->number{return unknown;}`,
		`fn main()->number{let x=true;x=1;return 1;}`,
		`fn main()->number{if true{return 1;}}`,
	}
	for _, s := range bad {
		p, e := Parse("invalid.swyp", s)
		if e != nil {
			continue
		}
		if m, e := p.CompileSTV2(); e == nil || m != nil {
			t.Fatalf("accepted %s", s)
		}
	}
	long := "fn main()->number{" + strings.Repeat("1;", vm.MaxInstructions+1) + "return 0;}"
	p, e := Parse("long.swyp", long)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = p.CompileSTV2(); e == nil || !strings.Contains(e.Error(), "instruction limit") {
		t.Fatal(e)
	}
	var nilProgram *Program
	if _, e := nilProgram.CompileSTV2(); e == nil {
		t.Fatal("nil program")
	}
	if _, e := (&Program{}).CompileSTV2(); e == nil {
		t.Fatal("zero program")
	}
	var nilModule *STV2Module
	if _, e := nilModule.Run(nil, 1); e == nil {
		t.Fatal("nil module")
	}
}

func TestSTV2CompiledExactBoundaries(t *testing.T) {
	for _, expr := range []string{"-2147483648", "2147483647", "-(-2147483648)", "0", "-0"} {
		p, m := stv2CompileTest(t, "fn main()->number{return "+expr+";}")
		stv2CompareTest(t, p, m, nil)
	}
	for _, body := range []string{"return arg(0)+1;", "return (arg(0)+1)-1;", "return arg(0)*2;"} {
		_, m := stv2CompileTest(t, "fn main()->number{"+body+"}")
		if _, e := m.Run([]int64{vm.MaxExactInteger}, 100); e == nil {
			t.Fatal("unsafe intermediate")
		}
	}
	p, m := stv2CompileTest(t, "fn main()->number{return arg(0);}")
	for _, a := range []int64{-vm.MaxExactInteger, vm.MaxExactInteger} {
		stv2CompareTest(t, p, m, []int64{a})
	}
	for _, a := range []int64{math.MinInt64, math.MaxInt64, vm.MaxExactInteger + 1} {
		if _, e := m.Run([]int64{a}, 100); e == nil {
			t.Fatal(a)
		}
	}
	if _, e := m.Run(nil, 100); e == nil {
		t.Fatal("missing argument")
	}
	if _, e := m.Run([]int64{1, 2}, 100); e == nil {
		t.Fatal("extra argument")
	}
	_, loop := stv2CompileTest(t, "fn main()->number{while true{}return 0;}")
	if _, e := loop.Run(nil, 100); e == nil {
		t.Fatal("fuel exhaustion")
	}
}

func TestSTV2ReusedModuleAndIndependentBytecode(t *testing.T) {
	_, m := stv2CompileTest(t, stv2SumSwyp)
	before := m.Bytecode()
	mutable := m.Bytecode()
	mutable[0] = 0
	if !bytes.Equal(before, m.Bytecode()) {
		t.Fatal("caller modified module")
	}
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(n int64) {
			defer wg.Done()
			r, e := m.Run([]int64{n}, 10000)
			if e != nil || r.Value != n*(n+1)/2 {
				t.Error(n, r, e)
			}
		}(int64(i))
	}
	wg.Wait()
}

func FuzzSTV2CompilerAudit(f *testing.F) {
	for _, s := range []string{stv2SumSwyp, "fn main()->number{return 42;}", "fn main()->bool{return true==1;}", "fn main()->number{while true{}return 0;}", ""} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > 4096 {
			return
		}
		p, e := Parse("fuzz.swyp", s)
		if e != nil {
			return
		}
		m, e := p.CompileSTV2()
		if e != nil {
			return
		}
		b := m.Bytecode()
		q, e := vm.DecodeV2(b)
		if e != nil {
			t.Fatal(e)
		}
		again, e := vm.EncodeV2(q)
		if e != nil || !bytes.Equal(b, again) {
			t.Fatal("noncanonical module", e)
		}
		args := make([]int64, m.ArgumentCount())
		a, ea := m.Run(args, 64)
		c, ec := m.Run(args, 64)
		if fmt.Sprint(ea) != fmt.Sprint(ec) || a != c {
			t.Fatal("nondeterministic run")
		}
	})
}

var stv2BenchSink any

func BenchmarkSTV2LoweredSum(b *testing.B) {
	p, m := stv2CompileTest(b, stv2SumSwyp)
	b.Run("SwypAST", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			v, e := stv2Reference(p, []int64{1000})
			if e != nil {
				b.Fatal(e)
			}
			stv2BenchSink = v
		}
	})
	b.Run("STV2Exact", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			v, e := m.Run([]int64{1000}, 100000)
			if e != nil {
				b.Fatal(e)
			}
			stv2BenchSink = v.Value
		}
	})
	b.Run("GoUncheckedReference", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var s int64
			for n := int64(1000); n > 0; n-- {
				s += n
			}
			stv2BenchSink = s
		}
	})
	b.Run("CompileIncludingCodec", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			v, e := p.CompileSTV2()
			if e != nil {
				b.Fatal(e)
			}
			stv2BenchSink = v
		}
	})
}
