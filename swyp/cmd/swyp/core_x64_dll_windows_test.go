//go:build windows && amd64

package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func TestCoreX64DLLLoadsAndExecutes(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	dllPath := filepath.Join(dir, "add.dll")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64DLLCommand([]string{"-entry", "add", "-o", dllPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	dll, err := syscall.LoadDLL(dllPath)
	if err != nil {
		t.Fatal(err)
	}
	defer dll.Release()
	proc, err := dll.FindProc("swyp_core_add")
	if err != nil {
		t.Fatal(err)
	}
	status := uint64(99)
	result, _, _ := proc.Call(20, 22, uintptr(unsafe.Pointer(&status)))
	runtime.KeepAlive(&status)
	if uint64(result) != 42 || status != 0 {
		t.Fatalf("result=%d status=%d want=42/0", result, status)
	}
}

func TestCoreX64DLLMixedFPCallsLoadAndExecute(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "fp.swyp")
	dllPath := filepath.Join(dir, "fp.dll")
	program := `
fn choose(c:bool,x:ieee64,y:ieee64)->ieee64 {
  let i:i64=0;
  while i<1 {
    if c { return x; }
    i=i+1;
  }
  return y;
}

func TestCoreX64DLLRelocatesWhenPreferredBaseIsOccupied(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	firstPath := filepath.Join(dir, "first.dll")
	secondPath := filepath.Join(dir, "second.dll")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64DLLCommand([]string{"-entry", "add", "-o", firstPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if err := coreX64DLLCommand([]string{"-entry", "add", "-o", secondPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	first, err := syscall.LoadDLL(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	second, err := syscall.LoadDLL(secondPath)
	if err != nil {
		t.Fatalf("second copy failed to relocate: %v", err)
	}
	defer second.Release()
	if first.Handle == second.Handle {
		t.Fatalf("two distinct DLL copies mapped at same handle 0x%x", uintptr(first.Handle))
	}
	for _, dll := range []*syscall.DLL{first, second} {
		proc, err := dll.FindProc("swyp_core_add")
		if err != nil {
			t.Fatal(err)
		}
		status := uint64(99)
		result, _, _ := proc.Call(11, 31, uintptr(unsafe.Pointer(&status)))
		runtime.KeepAlive(&status)
		if uint64(result) != 42 || status != 0 {
			t.Fatalf("handle=0x%x result=%d status=%d", uintptr(dll.Handle), result, status)
		}
	}
}
fn answer(c:bool,x:ieee64,y:ieee64)->ieee64 { return choose(c,x,y); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64DLLCommand([]string{"-entry", "answer", "-o", dllPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	harness := `
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
typedef double (*swyp_fn)(uint64_t,double,double,uint64_t*);
int main(int argc,char**argv){
  if(argc!=2)return 2;
  HMODULE h=LoadLibraryA(argv[1]);
  if(!h)return 3;
  swyp_fn fn=(swyp_fn)GetProcAddress(h,"swyp_core_answer");
  if(!fn)return 4;
  uint64_t s1=99,s2=99;
  double a=fn(1,7.25,9.5,&s1);
  double b=fn(0,7.25,9.5,&s2);
  printf("%.17g %llu %.17g %llu\n",a,(unsigned long long)s1,b,(unsigned long long)s2);
  FreeLibrary(h);
  return 0;
}
`
	cPath := filepath.Join(dir, "loader.c")
	exePath := filepath.Join(dir, "loader.exe")
	if err := os.WriteFile(cPath, []byte(harness), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(gcc, "-O1", cPath, "-o", exePath).CombinedOutput(); err != nil {
		t.Fatalf("compile DLL harness: %v\n%s", err, output)
	}
	output, err := exec.Command(exePath, dllPath).CombinedOutput()
	if err != nil {
		t.Fatalf("run DLL harness: %v\n%s", err, output)
	}
	if got := strings.TrimSpace(string(output)); got != "7.25 0 9.5 0" {
		t.Fatalf("output=%q", got)
	}
}
