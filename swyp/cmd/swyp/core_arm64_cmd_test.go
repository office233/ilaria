package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreARM64CommandCreatesAssembly(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	outPath := filepath.Join(dir, "add.s")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64Command([]string{"-entry", "add", "-o", outPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	assembly, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(assembly), ".global swyp_core_add") || !strings.Contains(out.String(), coreirMarkerARM64()) {
		t.Fatalf("assembly=%s output=%s", assembly, out.String())
	}
	if err := coreARM64Command([]string{"-entry", "add", "-o", outPath, source}, &out); err == nil {
		t.Fatal("core-arm64 overwrote existing output")
	}
}

func TestCoreARM64CommandNativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "call.swyp")
	outPath := filepath.Join(dir, "call.s")
	program := `
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
fn answer(n:i64)->i64 { return sum_to(n)+1; }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64Command([]string{"-entry", "answer", "-o", outPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	assembly, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(assembly)
	for _, want := range []string{
		".global swyp_core_answer",
		".global swyp_core_sum_to",
		"bl swyp_core_sum_to",
		"str x16, [x29, #",
		"cbnz x17, .Lswyp_arm64_answer_overflow",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("assembly missing %q:\n%s", want, text)
		}
	}
}

func TestCoreARM64CommandRejectsRecursiveNativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "recursive.swyp")
	outPath := filepath.Join(dir, "recursive.s")
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
	err := coreARM64Command([]string{"-entry", "recurse", "-o", outPath, source}, &out)
	if err == nil || !strings.Contains(err.Error(), "recursive call cycle") {
		t.Fatalf("err=%v", err)
	}
}

func TestCoreARM64CommandRejectsFPNativeCall(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-call.swyp")
	outPath := filepath.Join(dir, "fp-call.s")
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
	err := coreARM64Command([]string{"-entry", "answer", "-o", outPath, source}, &out)
	if err == nil || !strings.Contains(err.Error(), "result type ieee64 is unsupported") {
		t.Fatalf("err=%v", err)
	}
}

func coreirMarkerARM64() string { return "swyp-arm64-cfg-aapcs64-v1" }
