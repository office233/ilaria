package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreX64BuildCommandRuns(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	exe := filepath.Join(dir, "add.exe")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "add", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "20", "22").CombinedOutput()
	if err != nil || strings.TrimSpace(string(result)) != "42" {
		t.Fatalf("run err=%v out=%q", err, result)
	}
	result, err = exec.Command(exe, "9223372036854775807", "1").CombinedOutput()
	if err == nil || !strings.Contains(string(result), "backend-status=1") {
		t.Fatalf("overflow err=%v out=%q", err, result)
	}
	if err := coreX64BuildCommand([]string{"-entry", "add", "-o", exe, source}, &out); err == nil {
		t.Fatal("core-x64-build overwrote output")
	}
}

func TestCoreX64BuildCommandBranch(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "choose.swyp")
	exe := filepath.Join(dir, "choose.exe")
	if err := os.WriteFile(source, []byte("fn choose(c:bool,x:i64,y:i64)->i64{if c{return x;}return y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "choose", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"true", "7", "9"}, "7"},
		{[]string{"false", "7", "9"}, "9"},
	} {
		result, err := exec.Command(exe, tc.args...).CombinedOutput()
		if err != nil || strings.TrimSpace(string(result)) != tc.want {
			t.Fatalf("args=%v err=%v out=%q want=%s", tc.args, err, result, tc.want)
		}
	}
}

func TestCoreX64BuildCommandLoop(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "sum.swyp")
	exe := filepath.Join(dir, "sum.exe")
	if err := os.WriteFile(source, []byte(`
fn sum_to(n:i64)->i64 {
  if n<0 { return 0; }
  if n==0 { return 0; }
  let i:i64=1;
  let total:i64=0;
  while i<=n {
    total=total+i;
    i=i+1;
  }
  return total;
}

fn main(){}
`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "sum_to", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		arg  string
		want string
	}{
		{"0", "0"},
		{"1", "1"},
		{"10", "55"},
		{"100", "5050"},
	} {
		result, err := exec.Command(exe, tc.arg).CombinedOutput()
		if err != nil || strings.TrimSpace(string(result)) != tc.want {
			t.Fatalf("arg=%s err=%v out=%q want=%s", tc.arg, err, result, tc.want)
		}
	}
}

func TestCoreX64BuildCommandSpills(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "pressure.swyp")
	exe := filepath.Join(dir, "pressure.exe")
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
		t.Fatalf("test program did not force spills: %+v", artifact.Plan)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "pressure", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "1", "2", "3", "4").CombinedOutput()
	if err != nil {
		t.Fatalf("run err=%v out=%q", err, result)
	}
	if got := strings.TrimSpace(string(result)); got != "56" {
		t.Fatalf("result=%q want 56", got)
	}
}

func TestCoreX64BuildCommandInlinesSmallPureHelpers(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "inline.swyp")
	exe := filepath.Join(dir, "inline.exe")
	program := `
fn inc(x:i64)->i64 { return x+1; }
fn answer(x:i64)->i64 { return inc(x)+inc(x); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64LeafIR(source, "answer")
	if err != nil {
		t.Fatal(err)
	}
	for _, block := range artifact.Function.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				t.Fatalf("optimizer left call before x64 lowering: %+v", ins)
			}
		}
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "answer", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "20").CombinedOutput()
	if err != nil {
		t.Fatalf("run err=%v out=%q", err, result)
	}
	if got := strings.TrimSpace(string(result)); got != "42" {
		t.Fatalf("result=%q want 42", got)
	}
}

func TestCoreX64BuildCommandNativeCall(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "call.swyp")
	exe := filepath.Join(dir, "call.exe")
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
fn answer(n:i64)->i64 { return sum_to(n)+1; }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64CFG(source, "answer")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(artifact.Assembly, []byte("call swyp_core_sum_to_raw")) {
		t.Fatalf("native call was unexpectedly optimized away:\n%s", artifact.Assembly)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "answer", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "10").CombinedOutput()
	if err != nil {
		t.Fatalf("run err=%v out=%q", err, result)
	}
	if got := strings.TrimSpace(string(result)); got != "56" {
		t.Fatalf("result=%q want 56", got)
	}
}

func TestCoreX64BuildCommandNativeCallPropagatesOverflow(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "overflow-call.swyp")
	exe := filepath.Join(dir, "overflow-call.exe")
	program := `
fn checked_add(x:i64,y:i64)->i64 {
  if y==0 { return x; }
  if x==0 { return y; }
  return x+y;
}
fn answer(x:i64,y:i64)->i64 { return checked_add(x,y); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	artifact, err := compileX64CFG(source, "answer")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(artifact.Assembly, []byte("call swyp_core_checked_add_raw")) {
		t.Fatalf("overflow helper call was unexpectedly optimized away:\n%s", artifact.Assembly)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "answer", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "9223372036854775807", "1").CombinedOutput()
	if err == nil || !strings.Contains(string(result), "backend-status=1") {
		t.Fatalf("overflow err=%v out=%q", err, result)
	}
}

func TestCoreX64BuildCommandRejectsRecursiveNativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "recursive.swyp")
	exe := filepath.Join(dir, "recursive.exe")
	program := `
fn recurse(n:i64)->i64 {
  if n<=0 { return 0; }
  return recurse(n-1);
}
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64BuildCommand([]string{"-entry", "recurse", "-o", exe, source}, &out)
	if err == nil || !strings.Contains(err.Error(), "recursive call cycle") {
		t.Fatalf("err=%v", err)
	}
}

func TestCoreX64BuildCommandRejectsFPNativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-call.swyp")
	exe := filepath.Join(dir, "fp-call.exe")
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
	var out bytes.Buffer
	err := coreX64BuildCommand([]string{"-entry", "answer", "-o", exe, source}, &out)
	if err == nil || !strings.Contains(err.Error(), "result type ieee64 is unsupported") {
		t.Fatalf("err=%v", err)
	}
}

func TestCoreX64BuildCommandIEEE64(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "fp.swyp")
	exe := filepath.Join(dir, "fp.exe")
	if err := os.WriteFile(source, []byte("fn mul(x:ieee64,y:ieee64)->ieee64{return x*y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64BuildCommand([]string{"-entry", "mul", "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	result, err := exec.Command(exe, "1.5", "2").CombinedOutput()
	if err != nil || strings.TrimSpace(string(result)) != "3" {
		t.Fatalf("run err=%v out=%q", err, result)
	}
}

func TestCoreX64BuildCommandIEEE64NaNComparison(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		op   string
		want string
	}{
		{"eq", "==", "false"},
		{"ne", "!=", "true"},
		{"lt", "<", "false"},
		{"le", "<=", "false"},
		{"gt", ">", "false"},
		{"ge", ">=", "false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := filepath.Join(dir, tc.name+".swyp")
			exe := filepath.Join(dir, tc.name+".exe")
			program := fmt.Sprintf("fn cmp(x:ieee64,y:ieee64)->bool{return x%s y;} fn main(){}", tc.op)
			if err := os.WriteFile(source, []byte(program), 0600); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := coreX64BuildCommand([]string{"-entry", "cmp", "-o", exe, source}, &out); err != nil {
				t.Fatal(err)
			}
			result, err := exec.Command(exe, "nan", "nan").CombinedOutput()
			if err != nil || strings.TrimSpace(string(result)) != tc.want {
				t.Fatalf("op=%s err=%v out=%q want=%s", tc.op, err, result, tc.want)
			}
		})
	}
}
