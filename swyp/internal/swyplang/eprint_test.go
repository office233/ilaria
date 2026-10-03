package swyplang

import (
	"bytes"
	"testing"
)

func TestEprintUsesSeparateErrorWriter(t *testing.T) {
	p, err := Parse("eprint.swyp", `fn main(){print("out");eprint("err");}`)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := p.RunArgsIO(&stdout, &stderr, 100, nil); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "out\n" || stderr.String() != "err\n" {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}
