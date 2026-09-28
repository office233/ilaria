package coreir

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"math/rand"
	"strings"
	"sync"
	"testing"
)

func mustValue(t *testing.T, typ Type, text string) Value {
	t.Helper()
	v, err := ParseValue(typ, text)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func errorCode(err error) string {
	var d *Diagnostic
	if errors.As(err, &d) {
		return d.Code
	}
	return ""
}

func TestCoreI64BigIntegerOracle(t *testing.T) {
	rng := rand.New(rand.NewSource(271828))
	boundary := []int64{minI64, minI64 + 1, -9007199254740993, -3037000500, -2, -1, 0, 1, 2, 3037000500, 9007199254740993, maxI64 - 1, maxI64}
	cases := 0
	check := func(a, b int64) {
		for _, op := range []string{"add", "sub", "mul", "div", "rem"} {
			x, y, z := big.NewInt(a), big.NewInt(b), new(big.Int)
			wantCode := ""
			switch op {
			case "add":
				z.Add(x, y)
			case "sub":
				z.Sub(x, y)
			case "mul":
				z.Mul(x, y)
			case "div":
				if b == 0 {
					wantCode = "division_by_zero"
				} else {
					z.Quo(x, y)
				}
			case "rem":
				if b == 0 {
					wantCode = "division_by_zero"
				} else {
					z.Rem(x, y)
				}
			}
			if wantCode == "" && !z.IsInt64() {
				wantCode = "overflow"
			}
			got, err := Apply(op, Int(a), Int(b))
			cases++
			if wantCode != "" {
				if errorCode(err) != wantCode {
					t.Fatalf("%d %s %d: %v, want %s", a, op, b, err, wantCode)
				}
				continue
			}
			v, ok := got.Int64()
			if err != nil || !ok || v != z.Int64() {
				t.Fatalf("%d %s %d: %v %v, want %s", a, op, b, got, err, z.String())
			}
		}
	}
	for _, a := range boundary {
		for _, b := range boundary {
			check(a, b)
		}
	}
	for i := 0; i < 20000; i++ {
		check(int64(rng.Uint64()), int64(rng.Uint64()))
	}
	if _, err := Apply("neg", Int(minI64)); errorCode(err) != "overflow" {
		t.Fatal(err)
	}
	t.Logf("%d i64 operations checked against math/big", cases)
}

func TestCoreScalarSemantics(t *testing.T) {
	x := mustValue(t, I64, "9007199254740993")
	y, err := Apply("add", x, Int(1))
	if err != nil || y.Literal().Value != "9007199254740994" {
		t.Fatal(y, err)
	}
	encoded, _ := json.Marshal(x)
	if !strings.Contains(string(encoded), `"value":"9007199254740993"`) {
		t.Fatal(string(encoded))
	}
	for _, s := range []string{"9223372036854775808", "-9223372036854775809", "1.5", "NaN", ""} {
		if _, err := ParseValue(I64, s); err == nil {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"NaN", "Inf", "-Inf", "1e999", ""} {
		if _, err := ParseValue(F64, s); err == nil {
			t.Fatal(s)
		}
	}
	if _, err := Apply("add", Int(1), mustValue(t, F64, "1")); errorCode(err) != "type_mismatch" {
		t.Fatal(err)
	}
	zero := mustValue(t, F64, "-0")
	neg, _ := Apply("neg", zero)
	f, _ := neg.Float64()
	if math.Signbit(f) {
		t.Fatal("negating negative zero")
	}
	if _, err := Apply("div", mustValue(t, F64, "1"), zero); errorCode(err) != "division_by_zero" {
		t.Fatal(err)
	}
	if _, err := Apply("mul", mustValue(t, F64, "1e308"), mustValue(t, F64, "2")); errorCode(err) != "non_finite" {
		t.Fatal(err)
	}
	// The rounded intermediate product is zero after subtraction, not an FMA residual.
	a := mustValue(t, F64, "1.0000000000000002")
	b := mustValue(t, F64, "0.9999999999999998")
	product, err := Apply("mul", a, b)
	if err != nil {
		t.Fatal(err)
	}
	z, err := Apply("sub", product, mustValue(t, F64, "1"))
	fv, _ := z.Float64()
	if err != nil || fv != 0 {
		t.Fatal(z, err)
	}
}

func absModule() Module {
	return Module{Version: Version, Functions: []Function{{Name: "abs", Params: []Parameter{{Name: "x", Type: I64}}, Result: I64, Slots: []Type{I64, I64, Bool, I64}, Blocks: []Block{
		{Instructions: []Instruction{{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "0"}}, {Op: "ge", Dest: 2, Args: []int{0, 1}}}, Terminator: Terminator{Op: "branch", Value: 2, Targets: []int{1, 2}}},
		{Terminator: Terminator{Op: "return", Value: 0}},
		{Instructions: []Instruction{{Op: "neg", Dest: 3, Args: []int{0}, MayTrap: true}}, Terminator: Terminator{Op: "return", Value: 3}},
	}}}}
}
func TestCoreVerifierRejectsMalformedIR(t *testing.T) {
	mutations := map[string]func(*Module){
		"version":            func(m *Module) { m.Version++ },
		"duplicate":          func(m *Module) { m.Functions = append(m.Functions, m.Functions[0]) },
		"type":               func(m *Module) { m.Functions[0].Slots[2] = I64 },
		"missing definition": func(m *Module) { m.Functions[0].Blocks[1].Terminator.Value = 3 },
		"bad edge":           func(m *Module) { m.Functions[0].Blocks[0].Terminator.Targets[0] = 99 },
		"entry backedge":     func(m *Module) { m.Functions[0].Blocks[0].Terminator.Targets[0] = 0 },
		"trap metadata":      func(m *Module) { m.Functions[0].Blocks[2].Instructions[0].MayTrap = false },
		"opcode":             func(m *Module) { m.Functions[0].Blocks[2].Instructions[0].Op = "filesystem" },
		"effects":            func(m *Module) { m.Functions[0].Effects = []string{"network"} },
		"void slot":          func(m *Module) { m.Functions[0].Slots[3] = Void },
		"extra payload":      func(m *Module) { m.Functions[0].Blocks[2].Instructions[0].Constant = &Literal{Type: I64, Value: "0"} },
		"unknown call": func(m *Module) {
			m.Functions[0].Blocks[2].Instructions[0].Op = "call"
			m.Functions[0].Blocks[2].Instructions[0].Callee = "missing"
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			m := absModule()
			mutate(&m)
			if err := m.Validate(); err == nil {
				t.Fatal("accepted invalid IR")
			}
		})
	}
	// A definition on only one predecessor must not initialize the join.
	m := absModule()
	m.Functions[0].Blocks = append(m.Functions[0].Blocks, Block{Terminator: Terminator{Op: "return", Value: 3}})
	for _, i := range []int{1, 2} {
		m.Functions[0].Blocks[i].Terminator = Terminator{Op: "jump", Value: -1, Targets: []int{3}}
	}
	if err := m.Validate(); err == nil {
		t.Fatal("branch-only initialization accepted")
	}
}
func TestCoreExecutionOwnershipFuelAndConcurrency(t *testing.T) {
	m := absModule()
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	m.Functions[0].Blocks[0].Instructions[0].Constant.Value = "1000"
	for _, i := range []int64{-123, 0, 456, 9007199254740993} {
		r, err := e.Run(context.Background(), "abs", []Value{Int(i)}, 100)
		v, ok := r.Value.Int64()
		want := i
		if want < 0 {
			want = -want
		}
		if err != nil || !ok || v != want {
			t.Fatal(r, err)
		}
	}
	if _, err := e.Run(context.Background(), "abs", []Value{Int(minI64)}, 100); errorCode(err) != "overflow" {
		t.Fatal(err)
	}
	if _, err := e.Run(context.Background(), "abs", []Value{Int(1)}, 1); errorCode(err) != "fuel_exhausted" {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Run(ctx, "abs", []Value{Int(1)}, 100); errorCode(err) != "cancelled" {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if _, err := e.Run(context.Background(), "abs", []Value{Int(-7)}, 100); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
}
func TestCoreStrictJSON(t *testing.T) {
	for _, data := range []string{`{"version":1,"version":2}`, `{"Version":1,"version":2}`, `{"unknown":1}`, `null`, `{} {}`, `{"version":null}`, strings.Repeat("[", 130) + strings.Repeat("]", 130)} {
		var m Module
		if err := DecodeStrict([]byte(data), &m); err == nil {
			t.Fatalf("accepted %s", data)
		}
	}
	data, err := json.Marshal(absModule())
	if err != nil {
		t.Fatal(err)
	}
	m, err := Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	data2, _ := json.Marshal(m)
	if string(data) != string(data2) {
		t.Fatal("nondeterministic roundtrip")
	}
}
func FuzzCoreIRDecode(f *testing.F) {
	data, _ := json.Marshal(absModule())
	f.Add(data)
	f.Add([]byte(`{}`))
	f.Add([]byte("null"))
	f.Fuzz(func(t *testing.T, data []byte) {
		m, err := Decode(data)
		if err != nil {
			return
		}
		e, err := Prepare(m)
		if err != nil {
			return
		}
		fn := m.Functions[0]
		args := make([]Value, len(fn.Params))
		for i, p := range fn.Params {
			s := "0"
			if p.Type == Bool {
				s = "false"
			}
			args[i], _ = ParseValue(p.Type, s)
		}
		_, _ = e.Run(context.Background(), fn.Name, args, 64)
	})
}
