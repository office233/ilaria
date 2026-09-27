package swyplang

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Every fuel boundary must retain output, failure location and error ordering.
// The reference emitter performs each tick separately, as before optimization.
func TestNativeBatchedTickBoundaries(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	p, err := Parse("fuel.swyp", `
fn mark(x:number)->number { print(x); return -x; }
fn main(){
 let i=0;
 while i<3 {
   if i==1 || false && mark(90)>0 { print(mark(i)+2); }
   else { print(i); }
   i=i+1;
 }
 print(mark(7), 1/0);
}`)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	executables := []string{}
	for _, batch := range []bool{false, true} {
		src, err := p.emitC(batch)
		if err != nil {
			t.Fatal(err)
		}
		src = strings.Replace(src, "swyp_argc=argc-1;", `swyp_steps=strtoull(getenv("SWYP_TEST_STEPS"),NULL,10); swyp_argc=argc-1;`, 1)
		input := filepath.Join(dir, strconv.FormatBool(batch)+".c")
		exe := input + ".exe"
		if err := os.WriteFile(input, []byte(src), 0600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(gcc, "-std=c11", "-O2", "-ffp-contract=off", input, "-o", exe, "-lm").CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		executables = append(executables, exe)
	}
	for budget := 0; budget <= 180; budget++ {
		outputs := []string{}
		for _, exe := range executables {
			cmd := exec.Command(exe)
			cmd.Env = append(os.Environ(), "SWYP_TEST_STEPS="+strconv.Itoa(budget))
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatal("expected division or budget failure")
			}
			outputs = append(outputs, string(out))
		}
		if outputs[0] != outputs[1] {
			t.Fatalf("budget %d: baseline %q, optimized %q", budget, outputs[0], outputs[1])
		}
	}
}
