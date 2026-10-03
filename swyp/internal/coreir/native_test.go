package coreir

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func buildNativeCore(t *testing.T, m Module, entry string, profile NativeProfile) string {
	t.Helper()
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	src, err := EmitNativeC(m, entry, profile)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cfile := filepath.Join(dir, "core.c")
	exe := filepath.Join(dir, "core.exe")
	if err := os.WriteFile(cfile, src, 0600); err != nil {
		t.Fatal(err)
	}
	opt := "-O2"
	if profile == NativeFast {
		opt = "-O3"
	}
	if out, err := exec.Command(gcc, "-std=c11", opt, "-ffp-contract=off", cfile, "-o", exe, "-lm").CombinedOutput(); err != nil {
		t.Fatalf("compile: %v\n%s\n%s", err, out, src)
	}
	return exe
}

func TestNativeCoreAbsMatchesExecutor(t *testing.T) {
	m := absModule()
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, m, "abs", profile)
		for _, tc := range []struct{ in, want string }{{"-123", "123"}, {"0", "0"}, {"9007199254740993", "9007199254740993"}} {
			out, err := exec.Command(exe, tc.in).CombinedOutput()
			if err != nil || strings.TrimSpace(string(out)) != tc.want {
				t.Fatalf("%s input=%s err=%v out=%q", profile, tc.in, err, out)
			}
		}
		out, err := exec.Command(exe, "-9223372036854775808").CombinedOutput()
		if err == nil || !strings.Contains(string(out), "overflow") {
			t.Fatalf("%s expected overflow: err=%v out=%q", profile, err, out)
		}
	}
}

func TestFastNativeSmallHelperIsInline(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{
		{
			Name:   "helper",
			Params: []Parameter{{Name: "x", Type: I64}},
			Result: I64,
			Slots:  []Type{I64},
			Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}},
		},
		{
			Name:   "main",
			Result: Void,
			Blocks: []Block{{Terminator: Terminator{Op: "return", Value: -1}}},
		},
	}}
	src, err := EmitNativeC(m, "helper", NativeFast)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(src, []byte("SWYP_INLINE int64_t")) {
		t.Fatalf("fast source did not force-inline small helper:\n%s", src)
	}
}

func TestNativeCoreFastFuelBoundsCycle(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "main", Result: Void,
		Blocks: []Block{
			{Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
			{Terminator: Terminator{Op: "jump", Value: -1, Targets: []int{1}}},
		},
	}}}
	exe := buildNativeCore(t, m, "main", NativeFast)
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "SWYP_CORE_STEPS=3")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "execution step limit exceeded") {
		t.Fatalf("expected fuel failure: err=%v out=%q", err, out)
	}
}

func TestNativeCoreFastFuelBoundsRecursion(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name: "loop", Params: []Parameter{{Name: "x", Type: I64}}, Result: I64,
		Slots: []Type{I64, I64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "call", Dest: 1, Args: []int{0}, Callee: "loop", MayTrap: true}},
			Terminator:   Terminator{Op: "return", Value: 1},
		}},
	}}}
	exe := buildNativeCore(t, m, "loop", NativeFast)
	cmd := exec.Command(exe, "1")
	cmd.Env = append(os.Environ(), "SWYP_CORE_STEPS=4")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "execution step limit exceeded") {
		t.Fatalf("expected recursive fuel failure: err=%v out=%q", err, out)
	}
}

func TestNativeCoreRejectsEffectful(t *testing.T) {
	m := absModule()
	m.Functions[0].EffectVersion = EffectVersion
	m.Functions[0].Effects = []string{"filesystem.read"}
	m.Functions[0].RequiredCapabilities = []CapabilityRequirement{{Effect: "filesystem.read", Name: "workspace.read"}}
	if _, err := EmitNativeC(m, "abs", NativeFast); err == nil {
		t.Fatal("effectful module unexpectedly accepted by native AOT")
	}
}

func TestNativeCoreIEEE64AllowsNonFiniteHardwareResults(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "divide",
		Params: []Parameter{{Name: "x", Type: IEEE64}, {Name: "y", Type: IEEE64}},
		Result: IEEE64,
		Slots:  []Type{IEEE64, IEEE64, IEEE64},
		Blocks: []Block{{
			Instructions: []Instruction{{Op: "div", Dest: 2, Args: []int{0, 1}, MayTrap: false}},
			Terminator:   Terminator{Op: "return", Value: 2},
		}},
	}}}
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, m, "divide", profile)
		out, err := exec.Command(exe, "1", "0").CombinedOutput()
		if err != nil || !strings.Contains(strings.ToLower(string(out)), "inf") {
			t.Fatalf("%s expected infinity: err=%v out=%q", profile, err, out)
		}
	}
}

func TestNativeCoreU64MatchesWrapAndBitwiseSemantics(t *testing.T) {
	m := Module{Version: Version, Functions: []Function{{
		Name:   "mix",
		Params: []Parameter{{Name: "x", Type: U64}},
		Result: U64,
		Slots:  []Type{U64, U64, U64, U64, U64},
		Blocks: []Block{{
			Instructions: []Instruction{
				{Op: "const", Dest: 1, Constant: &Literal{Type: U64, Value: "1"}},
				{Op: "add", Dest: 2, Args: []int{0, 1}, MayTrap: false},
				{Op: "const", Dest: 3, Constant: &Literal{Type: U64, Value: "255"}},
				{Op: "band", Dest: 4, Args: []int{2, 3}, MayTrap: false},
			},
			Terminator: Terminator{Op: "return", Value: 4},
		}},
	}}}
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, m, "mix", profile)
		out, err := exec.Command(exe, "18446744073709551615").CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "0" {
			t.Fatalf("%s err=%v out=%q", profile, err, out)
		}
	}
}

func TestNativeCallDepthLimit(t *testing.T) {
	// fn f(n:i64)->i64{if n<=0{return 0;} return 1+f(n-1);}
	m := Module{
		Version: Version,
		Functions: []Function{{
			Name:   "f",
			Params: []Parameter{{Name: "n", Type: I64}},
			Result: I64,
			Slots:  []Type{I64, I64, Bool, I64, I64, I64, I64},
			Blocks: []Block{
				{
					Instructions: []Instruction{
						{Op: "const", Dest: 1, Constant: &Literal{Type: I64, Value: "0"}},
						{Op: "le", Dest: 2, Args: []int{0, 1}},
					},
					Terminator: Terminator{Op: "branch", Value: 2, Targets: []int{1, 2}},
				},
				{
					Terminator: Terminator{Op: "return", Value: 1},
				},
				{
					Instructions: []Instruction{
						{Op: "const", Dest: 3, Constant: &Literal{Type: I64, Value: "1"}},
						{Op: "sub", Dest: 4, Args: []int{0, 3}, MayTrap: true},
						{Op: "call", Dest: 5, Args: []int{4}, Callee: "f", MayTrap: true},
						{Op: "add", Dest: 6, Args: []int{3, 5}, MayTrap: true},
					},
					Terminator: Terminator{Op: "return", Value: 6},
				},
			},
		}},
	}
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, m, "f", profile)
		out, err := exec.Command(exe, "200").CombinedOutput()
		if err == nil {
			t.Fatalf("%s expected call_depth trap for n=200, got success with output %q", profile, out)
		}
		if !strings.Contains(string(out), "call_depth") {
			t.Fatalf("%s expected call_depth trap message, got %q", profile, out)
		}
	}
}

func TestNativeCoreU64RejectsLeadingWhitespaceAndSign(t *testing.T) {
	m := Module{
		Version: Version,
		Functions: []Function{{
			Name:   "identity_u64",
			Params: []Parameter{{Name: "x", Type: U64}},
			Result: U64,
			Slots:  []Type{U64},
			Blocks: []Block{{
				Terminator: Terminator{Op: "return", Value: 0},
			}},
		}},
	}
	for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
		exe := buildNativeCore(t, m, "identity_u64", profile)
		for _, invalid := range []string{" -1", "-1", "+1", " 42", "42 "} {
			out, err := exec.Command(exe, invalid).CombinedOutput()
			if err == nil {
				t.Fatalf("%s expected failure for input %q, got success", profile, invalid)
			}
			if !strings.Contains(string(out), "invalid u64 argument") {
				t.Fatalf("%s expected invalid u64 argument error for %q, got %q", profile, invalid, out)
			}
		}
	}
}
