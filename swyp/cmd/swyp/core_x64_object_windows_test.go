//go:build windows && amd64

package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreX64COFFObjectLinksAndExecutes(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	objectPath := filepath.Join(dir, "add.obj")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ObjectCommand([]string{"-format", "coff", "-entry", "add", "-o", objectPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	harness := `
#include <stdint.h>
#include <stdio.h>
extern uint64_t swyp_core_add(uint64_t,uint64_t,uint64_t*);
int main(void) {
  uint64_t status=99;
  uint64_t value=swyp_core_add(20,22,&status);
  printf("%llu %llu\n",(unsigned long long)value,(unsigned long long)status);
  return 0;
}
`
	got := linkAndRunX64COFFHarness(t, gcc, dir, objectPath, harness)
	if got != "42 0" {
		t.Fatalf("output=%q want=%q", got, "42 0")
	}
}

func TestCoreX64COFFObjectMixedFPCallsLinkAndExecute(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "fp.swyp")
	objectPath := filepath.Join(dir, "fp.obj")
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
	if err := coreX64ObjectCommand([]string{"-format", "coff", "-entry", "answer", "-o", objectPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	harness := `
#include <stdint.h>
#include <stdio.h>
extern double swyp_core_answer(uint64_t,double,double,uint64_t*);
int main(void) {
  uint64_t s1=99,s2=99;
  double a=swyp_core_answer(1,7.25,9.5,&s1);
  double b=swyp_core_answer(0,7.25,9.5,&s2);
  printf("%.17g %llu %.17g %llu\n",a,(unsigned long long)s1,b,(unsigned long long)s2);
  return 0;
}
`
	got := linkAndRunX64COFFHarness(t, gcc, dir, objectPath, harness)
	if got != "7.25 0 9.5 0" {
		t.Fatalf("output=%q", got)
	}
}

func linkAndRunX64COFFHarness(t *testing.T, gcc, dir, objectPath, source string) string {
	t.Helper()
	cPath := filepath.Join(dir, "harness.c")
	exePath := filepath.Join(dir, "harness.exe")
	if err := os.WriteFile(cPath, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(gcc, "-O1", cPath, objectPath, "-o", exePath).CombinedOutput(); err != nil {
		t.Fatalf("link harness: %v\n%s", err, output)
	}
	output, err := exec.Command(exePath).CombinedOutput()
	if err != nil {
		t.Fatalf("run harness: %v\n%s", err, output)
	}
	return strings.TrimSpace(string(output))
}
