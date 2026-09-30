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

func TestByteSpanDescriptorRoundTrip(t *testing.T) {
	v, err := ByteSpan(0x12345678, 0x10203040)
	if err != nil {
		t.Fatal(err)
	}
	if v.Type() != Bytes {
		t.Fatalf("type=%s", v.Type())
	}
	offset, length, ok := v.ByteSpan()
	if !ok || offset != 0x12345678 || length != 0x10203040 {
		t.Fatalf("offset=%08x length=%08x ok=%v", offset, length, ok)
	}
	if _, err := ByteSpan(^uint32(0), 2); err == nil {
		t.Fatal("wrapping byte span unexpectedly accepted")
	}
}

func TestBytesTransportAcrossCoreExecutionModes(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "id",
		Params: []Parameter{{Name: "x", Type: Bytes}},
		Result: Bytes,
		Slots:  []Type{Bytes},
		Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	arg, err := ByteSpan(64, 17)
	if err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func(context.Context, string, []Value, int) (RunResult, error){
		"run":   e.Run,
		"fast":  e.RunFast,
		"turbo": e.RunTurbo,
	} {
		got, err := run(context.Background(), "id", []Value{arg}, 100)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		offset, length, ok := got.Value.ByteSpan()
		if !ok || offset != 64 || length != 17 {
			t.Fatalf("%s: value=%v offset=%d length=%d ok=%v", name, got.Value, offset, length, ok)
		}
	}
}

func TestBytesCannotBeForgedByGuestConstantsOrArithmetic(t *testing.T) {
	constant := Module{Version: Version, Functions: []Function{{
		Name:   "bad",
		Result: Bytes,
		Slots:  []Type{Bytes},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "const", Dest: 0, Constant: &Literal{Type: Bytes, Value: "00000000:00000001"}}},
			Terminator:   Terminator{Op: "return", Value: 0},
		}},
	}}}
	if err := constant.Validate(); err == nil {
		t.Fatal("guest-forged bytes constant unexpectedly accepted")
	}

	arithmetic := Module{Version: Version, Functions: []Function{{
		Name:   "bad",
		Params: []Parameter{{Name: "a", Type: Bytes}, {Name: "b", Type: Bytes}},
		Result: Bytes,
		Slots:  []Type{Bytes, Bytes, Bytes},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "add", Dest: 2, Args: []int{0, 1}}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}}}
	if err := arithmetic.Validate(); err == nil {
		t.Fatal("bytes arithmetic unexpectedly accepted")
	}
}

func TestBytesConstantResolvesInsideImmutableModuleArena(t *testing.T) {
	v, err := ByteSpan(1, 5)
	if err != nil {
		t.Fatal(err)
	}
	lit := v.Literal()
	m := Module{
		Version: Version,
		Data:    []byte("_hello!"),
		Functions: []Function{{
			Name:   "lit",
			Result: Bytes,
			Slots:  []Type{Bytes},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "const", Dest: 0, Constant: &lit}},
				Terminator:   Terminator{Op: "return", Value: 0},
			}},
		}},
	}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	// Mutating the source module after Prepare must not alter the executable.
	m.Data[1] = 'X'
	result, err := e.Run(context.Background(), "lit", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.ResolveBytes(result.Value)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Fatalf("resolved=%q", got)
	}
	got[0] = 'X'
	again, err := e.ResolveBytes(result.Value)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != "hello" {
		t.Fatalf("resolver returned mutable alias: %q", again)
	}
}

func TestBytesConstantMustStayInsideModuleArena(t *testing.T) {
	v, err := ByteSpan(2, 4)
	if err != nil {
		t.Fatal(err)
	}
	lit := v.Literal()
	m := Module{
		Version: Version,
		Data:    []byte("abc"),
		Functions: []Function{{
			Name:   "bad",
			Result: Bytes,
			Slots:  []Type{Bytes},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "const", Dest: 0, Constant: &lit}},
				Terminator:   Terminator{Op: "return", Value: 0},
			}},
		}},
	}
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "outside module arena") {
		t.Fatalf("out-of-bounds bytes constant err=%v", err)
	}
}

func TestBytesArenaSurvivesStrictJSONRoundTrip(t *testing.T) {
	v, err := ByteSpan(2, 4)
	if err != nil {
		t.Fatal(err)
	}
	lit := v.Literal()
	m := Module{
		Version: Version,
		Data:    []byte("__data__"),
		Functions: []Function{{
			Name:   "lit",
			Result: Bytes,
			Slots:  []Type{Bytes},
			Blocks: []Block{{
				Instructions: []Instruction{{Op: "const", Dest: 0, Constant: &lit}},
				Terminator:   Terminator{Op: "return", Value: 0},
			}},
		}},
	}
	encoded, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded.Data) != "__data__" {
		t.Fatalf("data=%q", decoded.Data)
	}
	e, err := Prepare(decoded)
	if err != nil {
		t.Fatal(err)
	}
	result, err := e.Run(context.Background(), "lit", nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.ResolveBytes(result.Value)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "data" {
		t.Fatalf("resolved=%q", got)
	}
}

func TestCoreIEEE64SemanticsAreExplicitlyNonFinite(t *testing.T) {
	one := mustValue(t, IEEE64, "1")
	zero := mustValue(t, IEEE64, "0")
	inf, err := Apply("div", one, zero)
	if err != nil {
		t.Fatal(err)
	}
	f, ok := inf.Float64()
	if !ok || !math.IsInf(f, 1) || inf.Type() != IEEE64 {
		t.Fatalf("division result=%v", inf.Literal())
	}

	nan, err := Apply("div", zero, zero)
	if err != nil {
		t.Fatal(err)
	}
	nf, _ := nan.Float64()
	if !math.IsNaN(nf) {
		t.Fatalf("zero/zero=%v", nan.Literal())
	}
	for _, op := range []string{"lt", "le", "gt", "ge", "eq"} {
		got, err := Apply(op, nan, one)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := got.Boolean()
		if b {
			t.Fatalf("NaN %s 1 unexpectedly true", op)
		}
	}
	ne, err := Apply("ne", nan, one)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := ne.Boolean()
	if !b {
		t.Fatal("NaN != 1 must be true")
	}

	if _, err := Apply("div", mustValue(t, F64, "1"), mustValue(t, F64, "0")); errorCode(err) != "division_by_zero" {
		t.Fatalf("strict f64 changed: %v", err)
	}
	if _, err := ParseValue(F64, "Inf"); err == nil {
		t.Fatal("strict f64 accepted Inf")
	}
	if v, err := ParseValue(IEEE64, "Inf"); err != nil || v.Type() != IEEE64 {
		t.Fatalf("ieee64 Inf: %v %v", v, err)
	}
}

func TestCoreU64WrapBitwiseAndShiftSemantics(t *testing.T) {
	max := mustValue(t, U64, "18446744073709551615")
	one := Uint(1)
	zero, err := Apply("add", max, one)
	if err != nil || zero.Literal().Value != "0" {
		t.Fatalf("wrap add=%v err=%v", zero.Literal(), err)
	}
	wrapped, err := Apply("sub", Uint(0), one)
	if err != nil || wrapped.Literal().Value != "18446744073709551615" {
		t.Fatalf("wrap sub=%v err=%v", wrapped.Literal(), err)
	}
	masked, err := Apply("band", Uint(0xff00), Uint(0x0ff0))
	if err != nil || masked.Literal().Value != "3840" {
		t.Fatalf("band=%v err=%v", masked.Literal(), err)
	}
	shifted, err := Apply("shl", Uint(1), Uint(63))
	if err != nil || shifted.Literal().Value != "9223372036854775808" {
		t.Fatalf("shift=%v err=%v", shifted.Literal(), err)
	}
	if _, err := Apply("shl", Uint(1), Uint(64)); errorCode(err) != "shift_out_of_range" {
		t.Fatalf("shift 64 err=%v", err)
	}
	if _, err := Apply("div", Uint(1), Uint(0)); errorCode(err) != "division_by_zero" {
		t.Fatalf("u64 div zero err=%v", err)
	}
	if _, err := ParseValue(U64, "-1"); err == nil {
		t.Fatal("u64 accepted negative literal")
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

func TestCoreRunFastMatchesExactValueAndErrors(t *testing.T) {
	e, err := Prepare(absModule())
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []int64{-123, -1, 0, 1, 456, 9007199254740993} {
		exact, exactErr := e.Run(context.Background(), "abs", []Value{Int(input)}, 100)
		fast, fastErr := e.RunFast(context.Background(), "abs", []Value{Int(input)}, 100)
		if exactErr != nil || fastErr != nil {
			t.Fatalf("input=%d exact=%v fast=%v", input, exactErr, fastErr)
		}
		exactValue, _ := exact.Value.Int64()
		fastValue, _ := fast.Value.Int64()
		if exactValue != fastValue {
			t.Fatalf("input=%d exact=%d fast=%d", input, exactValue, fastValue)
		}
	}
	_, exactErr := e.Run(context.Background(), "abs", []Value{Int(minI64)}, 100)
	_, fastErr := e.RunFast(context.Background(), "abs", []Value{Int(minI64)}, 100)
	if errorCode(exactErr) != "overflow" || errorCode(fastErr) != "overflow" {
		t.Fatalf("overflow mismatch exact=%v fast=%v", exactErr, fastErr)
	}
}

func TestCoreRunFastLoopBackedgeFuelIsBounded(t *testing.T) {
	zero := Literal{Type: I64, Value: "0"}
	one := Literal{Type: I64, Value: "1"}
	m := Module{Version: Version, Functions: []Function{{
		Name:   "count",
		Params: []Parameter{{Name: "n", Type: I64}},
		Result: I64,
		Slots:  []Type{I64, I64, I64, Bool},
		Blocks: []Block{
			{
				Instructions: []Instruction{
					{Op: "const", Dest: 1, Constant: &zero, MayTrap: false},
					{Op: "const", Dest: 2, Constant: &one, MayTrap: false},
				},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}},
			},
			{
				Instructions: []Instruction{
					{Op: "lt", Dest: 3, Args: []int{1, 0}, MayTrap: false},
				},
				Terminator: Terminator{Op: "branch", Value: 3, Targets: []int{2, 3}},
			},
			{
				Instructions: []Instruction{
					{Op: "add", Dest: 1, Args: []int{1, 2}, MayTrap: true},
				},
				Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}},
			},
			{
				Terminator: Terminator{Op: "return", Value: 1},
			},
		},
	}}}
	e, err := Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.RunFast(context.Background(), "count", []Value{Int(3)}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if value, _ := got.Value.Int64(); value != 3 {
		t.Fatalf("value=%d want 3", value)
	}
	if got.Steps != 4 { // function entry + three taken loop backedges
		t.Fatalf("steps=%d want 4", got.Steps)
	}
	if _, err := e.RunFast(context.Background(), "count", []Value{Int(10)}, 2); errorCode(err) != "fuel_exhausted" {
		t.Fatalf("expected fuel exhaustion, got %v", err)
	}
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
