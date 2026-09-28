package swyplang

import (
	"bytes"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	vm "swyp-lang/experiments/ternaryvm"
)

func TestSTV2ReadOnlyOperandPressure(t *testing.T) {
	seven := "let a=1;let b=2;let c=3;let d=4;let e=5;let f=6;let g=7;"
	cases := []struct{ name, body string }{
		{"binary_rhs", seven + "return a+b;"},
		{"return", seven + "let h=8;return a;"},
		{"assignment", seven + "let h=8;a=b;return a;"},
		{"discard", seven + "let h=8;a;return h;"},
		{"condition", seven + "let h=true;if h{return a;}else{return b;}"},
		{"loop_condition", "let a=1;let b=2;let c=3;let d=4;let e=5;let f=6;let active=false;let stop=false;while active{active=stop;}return a;"},
		{"four_arguments", "let a=arg(0);let b=arg(1);let c=arg(2);return a+arg(3);"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, m := stv2CompileTest(t, "fn main()->number{"+tc.body+"}")
			args := make([]int64, m.ArgumentCount())
			for i := range args {
				args[i] = int64(i + 10)
			}
			stv2CompareTest(t, p, m, args)
		})
	}
	// Eight genuinely live variables plus a writable arithmetic temporary still
	// exceed this backend. This optimization does not introduce spilling.
	p, err := Parse("pressure.swyp", "fn main()->number{"+seven+"let h=8;return a+b;}")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.CompileSTV2(); err == nil || !strings.Contains(err.Error(), "register pressure") {
		t.Fatalf("expected register pressure, got %v", err)
	}
}

func TestSTV2OperandAliasingAndControlFlow(t *testing.T) {
	programs := []string{
		"let x=arg(0);let y=x;y=y+1;return x+y+arg(0);",
		"let x=arg(0);x=x+x;return x+arg(0);",
		"let x=arg(0);x=x-x;return x+arg(0);",
		"let x=arg(0);let y=x;x=y;return x+y;",
		"let x=arg(0);if true{let x=x+1;x=x+x;}return x;",
		"let x=arg(0);let y=3;while y>0{x=x+y;y=y-1;}return x;",
		"let x=arg(0);let p=x>0;let q=false;if p||q{x=x+1;}if p&&q{x=0;}return x;",
		"let x=arg(0);let p=x>0;let q=p;q=!q;if p==q{return 42;}return x;",
		"let x=arg(0);let p=x>0;if p&&false{return 99;}if p||true{return x;}return 0;",
		"let x=arg(0);let y=arg(1);x=y-x;y=x-y;return x*3+y;",
		"let x=arg(0);let y=arg(1);return (x<y)==(x>=y);",
		"let x=arg(0);let y=arg(1);return (x%7)+(y%5);",
	}
	for i, body := range programs {
		kind := "number"
		if i == 10 {
			kind = "bool"
		}
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			p, m := stv2CompileTest(t, "fn main()->"+kind+"{"+body+"}")
			encoded, err := m.MarshalBinary()
			if err != nil {
				t.Fatal(err)
			}
			loaded, err := LoadSWYPB(encoded)
			if err != nil {
				t.Fatal(err)
			}
			for n := int64(-9); n <= 9; n++ {
				args := make([]int64, m.ArgumentCount())
				for j := range args {
					args[j] = n + int64(j)
				}
				stv2CompareTest(t, p, m, args)
				stv2CompareTest(t, p, loaded, args)
			}
		})
	}
}

func TestSTV2OperandTrapPreservation(t *testing.T) {
	for _, body := range []string{
		"let x=arg(0);let y=0;return x%y;",
		"let x=arg(0);let y=0;x%y;return 7;",
		"let x=arg(0);let y=0;return (x%y)==false;",
		"let x=arg(0);let p=true;return p&&(x%0==0);",
		"let x=arg(0);let p=false;return p||(x%0==0);",
	} {
		kind := "number"
		if strings.Contains(body, "==") {
			kind = "bool"
		}
		p, m := stv2CompileTest(t, "fn main()->"+kind+"{"+body+"}")
		if _, err := stv2Reference(p, []int64{7}); err == nil {
			t.Fatal("reference did not trap", body)
		}
		if _, err := m.Run([]int64{7}, 1000); err == nil {
			t.Fatal("optimized bytecode did not trap", body)
		}
	}
	for _, body := range []string{
		"let x=arg(0);let y=1;return (x+y)-y;",
		"let x=arg(0);let y=2;return x*y;",
	} {
		_, m := stv2CompileTest(t, "fn main()->number{"+body+"}")
		if _, err := m.Run([]int64{vm.MaxExactInteger}, 1000); err == nil {
			t.Fatal("unsafe intermediate was removed", body)
		}
	}
	for _, body := range []string{
		"let p=false;return p&&(1%0==0);",
		"let p=true;return p||(1%0==0);",
	} {
		p, m := stv2CompileTest(t, "fn main()->bool{"+body+"}")
		stv2CompareTest(t, p, m, nil)
	}
}

func TestSTV2OperandGeneratedStateful(t *testing.T) {
	const seed int64 = 20260928
	rng := rand.New(rand.NewSource(seed))
	updates := []string{"x=(x+y)%97;", "x=(x-y)%97;", "x=(x*3+y)%97;", "x=(z+x)%97;"}
	seen := make(map[string]bool)
	comparisons := 0
	for attempts := 0; len(seen) < 1200; attempts++ {
		if attempts >= 10000 {
			t.Fatal("unique-program generation budget exhausted")
		}
		ai, bi := rng.Intn(len(updates)), rng.Intn(len(updates))
		iterations, offset, modulus := rng.Intn(6)+1, rng.Intn(21)-10, rng.Intn(95)+9
		source := fmt.Sprintf("fn main()->number{let x=arg(0);let y=arg(1);let z=x+(%d);let n=%d;while n>0{if x<y{%s}else{%s}y=(z-y)%%%d;z=x;n=n-1;}return x+y+z;}", offset, iterations, updates[ai], updates[bi], modulus)
		if seen[source] {
			continue
		}
		seen[source] = true
		p, m := stv2CompileTest(t, source)
		again, err := p.CompileSTV2()
		if err != nil || !bytes.Equal(m.Bytecode(), again.Bytecode()) {
			t.Fatalf("nondeterministic program %d: %v", len(seen), err)
		}
		encoded, err := m.MarshalBinary()
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadSWYPB(encoded)
		if err != nil {
			t.Fatal(err)
		}
		for _, inputX := range []int64{-7, 0, 9} {
			for _, inputY := range []int64{-5, 0, 11} {
				args := []int64{inputX, inputY}
				stv2CompareTest(t, p, loaded, args)
				// Independent integer oracle: does not parse or interpret Swyp.
				x, y, z := inputX, inputY, inputX+int64(offset)
				for n := 0; n < iterations; n++ {
					op := bi
					if x < y {
						op = ai
					}
					switch op {
					case 0:
						x = (x + y) % 97
					case 1:
						x = (x - y) % 97
					case 2:
						x = (x*3 + y) % 97
					case 3:
						x = (z + x) % 97
					}
					y = (z - y) % int64(modulus)
					z = x
				}
				got, err := loaded.Run(args, 10000)
				if err != nil || got.Value != x+y+z {
					t.Fatalf("independent oracle mismatch: inputs=%v got=%v err=%v want=%d source=%s", args, got, err, x+y+z, source)
				}
				comparisons++
			}
		}
	}
	t.Logf("distinct stateful sources=%d input cases=%d; each checked against AST and independent Go oracle; seed=%d", len(seen), comparisons, seed)
}
