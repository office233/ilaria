package swyplang

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeFastPreservesValueSemantics(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	p, err := Parse("fast.swyp", `
fn sum(n:number)->number {
  let i=0;
  let total=0;
  while i<n {
    total=total+i;
    i=i+1;
  }
  return total;
}
fn main(){ print(sum(arg(0))); }
`)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	outputs := make([]string, 0, 2)
	for _, fast := range []bool{false, true} {
		var src string
		if fast {
			src, err = p.EmitCFast()
		} else {
			src, err = p.EmitC()
		}
		if err != nil {
			t.Fatal(err)
		}
		input := filepath.Join(dir, map[bool]string{false: "safe.c", true: "fast.c"}[fast])
		exe := input + ".exe"
		if err := os.WriteFile(input, []byte(src), 0600); err != nil {
			t.Fatal(err)
		}
		opt := "-O2"
		if fast {
			opt = "-O3"
		}
		if out, err := exec.Command(gcc, "-std=c11", opt, "-ffp-contract=off", input, "-o", exe, "-lm").CombinedOutput(); err != nil {
			t.Fatalf("compile fast=%v: %v: %s", fast, err, out)
		}
		out, err := exec.Command(exe, "1000").CombinedOutput()
		if err != nil {
			t.Fatalf("run fast=%v: %v: %s", fast, err, out)
		}
		outputs = append(outputs, strings.TrimSpace(string(out)))
	}
	if outputs[0] != outputs[1] || outputs[0] != "499500" {
		t.Fatalf("safe=%q fast=%q", outputs[0], outputs[1])
	}
}

func TestNativeFastStillBoundsInfiniteLoop(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc unavailable")
	}
	p, err := Parse("loop.swyp", `fn main(){ while true {} }`)
	if err != nil {
		t.Fatal(err)
	}
	src, err := p.EmitCFast()
	if err != nil {
		t.Fatal(err)
	}
	src = strings.Replace(src, "swyp_argc=argc-1;", "swyp_steps=3; swyp_argc=argc-1;", 1)
	dir := t.TempDir()
	input := filepath.Join(dir, "loop.c")
	exe := input + ".exe"
	if err := os.WriteFile(input, []byte(src), 0600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(gcc, "-std=c11", "-O3", "-ffp-contract=off", input, "-o", exe, "-lm").CombinedOutput(); err != nil {
		t.Fatalf("compile: %v: %s", err, out)
	}
	out, err := exec.Command(exe).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "execution step limit exceeded") {
		t.Fatalf("expected budget failure, err=%v out=%q", err, out)
	}
}
