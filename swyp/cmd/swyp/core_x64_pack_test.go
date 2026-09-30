package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestCoreX64PackCommandCreatesVerifiedModule(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	modulePath := filepath.Join(dir, "add.swx64")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "add", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.Entry != "add" || module.Header.ABI != coreir.X64LeafABI {
		t.Fatalf("header=%+v", module.Header)
	}
	if len(module.Header.Params) != 2 || module.Header.Params[0] != coreir.I64 || module.Header.Result != coreir.I64 {
		t.Fatalf("signature=%+v -> %s", module.Header.Params, module.Header.Result)
	}
	if len(module.Code) == 0 || !strings.Contains(out.String(), module.Header.CodeSHA256) {
		t.Fatalf("output=%q code=%d", out.String(), len(module.Code))
	}
	if err := coreX64PackCommand([]string{"-entry", "add", "-o", modulePath, source}, &out); err == nil {
		t.Fatal("core-x64-pack overwrote existing module")
	}
}

func TestCoreX64PackCommandRejectsRandomEffect(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "rng.swyp")
	modulePath := filepath.Join(dir, "rng.swx64")
	if err := os.WriteFile(source, []byte("fn sample()->u64{return random();} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "sample", "-o", modulePath, source}, &out); err == nil || !strings.Contains(err.Error(), "pure") {
		t.Fatalf("effectful x64 pack error=%v", err)
	}
}

func TestCoreX64PackCommandCFG(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "choose.swyp")
	modulePath := filepath.Join(dir, "choose.swx64")
	program := "fn choose(c:bool,x:i64,y:i64)->i64{if c{return x;}return y;} fn main(){}"
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "choose", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineABI {
		t.Fatalf("abi=%q want %q", module.Header.ABI, coreir.X64CFGMachineABI)
	}
}

func TestCoreX64PackCommandLoopCFG(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "sum.swyp")
	modulePath := filepath.Join(dir, "sum.swx64")
	program := `
fn sum_to(n:i64)->i64 {
  let i:i64=1;
  let total:i64=0;
  while i<=n {
    total=total+i;
    i=i+1;
  }
  return total;
}
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "sum_to", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineABI {
		t.Fatalf("abi=%q want %q", module.Header.ABI, coreir.X64CFGMachineABI)
	}
	if len(module.Code) < 32 {
		t.Fatalf("loop CFG machine code unexpectedly tiny: %d bytes", len(module.Code))
	}
}

func TestCoreX64PackCommandCFGWithSpills(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "pressure.swyp")
	modulePath := filepath.Join(dir, "pressure.swx64")
	program := `
fn pressure(a:i64,b:i64,c:i64,d:i64)->i64 {
  let a1:i64=a+1;
  let b1:i64=b+2;
  let c1:i64=c+3;
  let d1:i64=d+4;
  let a2:i64=a+5;
  let b2:i64=b+6;
  let c2:i64=c+7;
  let d2:i64=d+8;
  let s1:i64=a1+b1;
  let s2:i64=c1+d1;
  let s3:i64=a2+b2;
  let s4:i64=c2+d2;
  return (s1+s2)+(s3+s4);
}
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64LeafIR(source, "pressure")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Plan.Spills == 0 {
		t.Fatalf("fixture did not force spills: %+v", artifact.Plan)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "pressure", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineABI {
		t.Fatalf("abi=%q want %q", module.Header.ABI, coreir.X64CFGMachineABI)
	}
	if len(module.Code) < 64 {
		t.Fatalf("spilled CFG machine code unexpectedly tiny: %d", len(module.Code))
	}
}

func TestCoreX64PackCommandScalarCalls(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "calls.swyp")
	modulePath := filepath.Join(dir, "calls.swx64")
	program := `
fn sum_to(n:i64)->i64 {
  let i:i64=1;
  let total:i64=0;
  while i<=n {
    total=total+i;
    i=i+1;
  }
  return total;
}
fn entry(n:i64)->i64 { return sum_to(n)+1; }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64ModuleIR(source, "entry")
	if err != nil {
		t.Fatal(err)
	}
	if len(artifact.Functions) < 2 {
		t.Fatalf("fixture call was unexpectedly eliminated: functions=%d", len(artifact.Functions))
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "entry", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineCallsABI || module.Header.Entry != "entry" {
		t.Fatalf("header=%+v", module.Header)
	}
}

func TestCoreX64PackCommandIEEE64(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp.swyp")
	modulePath := filepath.Join(dir, "fp.swx64")
	if err := os.WriteFile(source, []byte("fn mul(x:ieee64,y:ieee64)->ieee64{return x*y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "mul", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineFPABI || module.Header.Result != coreir.IEEE64 {
		t.Fatalf("header=%+v", module.Header)
	}
}

func TestCoreX64PackCommandIEEE64NativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-call.swyp")
	modulePath := filepath.Join(dir, "fp-call.swx64")
	program := `
fn choose(c:bool,x:ieee64,y:ieee64)->ieee64 {
  let i:i64=0;
  while i<1 {
    if c { return x; }
    i=i+1;
  }
  return y;
}
fn answer(c:bool,x:ieee64,y:ieee64)->ieee64 { return choose(c,x,y); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64PackModuleIR(source, "answer")
	if err != nil {
		t.Fatal(err)
	}
	if len(artifact.Functions) < 2 {
		t.Fatalf("fixture FP call was unexpectedly eliminated: functions=%d", len(artifact.Functions))
	}
	var out bytes.Buffer
	if err := coreX64PackCommand([]string{"-entry", "answer", "-o", modulePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(modulePath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.DecodeX64Module(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if module.Header.ABI != coreir.X64CFGMachineFPCallsABI || module.Header.Entry != "answer" || module.Header.Result != coreir.IEEE64 {
		t.Fatalf("header=%+v", module.Header)
	}
}

func TestCoreX64PackCommandRejectsProcessIO(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "print.swyp")
	if err := os.WriteFile(source, []byte(`fn answer(x:i64)->i64{print(x);return x;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64PackCommand([]string{"-entry", "answer", "-o", filepath.Join(dir, "print.swx64"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "pure") {
		t.Fatalf("packed module unexpectedly admitted process IO: %v", err)
	}
}

func BenchmarkCoreX64PackPipeline(b *testing.B) {
	dir := b.TempDir()
	source := filepath.Join(dir, "mix.swyp")
	if err := os.WriteFile(source, []byte(`
fn mix(x:i64,y:i64)->i64 {
  let a:i64=x+y;
  let b:i64=a*3;
  let c:i64=b-y;
  let d:i64=c+17;
  return d;
}
fn main(){}
`), 0600); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		artifact, err := compileX64LeafIR(source, "mix")
		if err != nil {
			b.Fatal(err)
		}
		code, err := coreir.EmitX64LeafMachineCode(artifact.SSA, artifact.Plan)
		if err != nil {
			b.Fatal(err)
		}
		module, err := coreir.NewX64Module(artifact.SSA, code)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := coreir.EncodeX64Module(module); err != nil {
			b.Fatal(err)
		}
	}
}
