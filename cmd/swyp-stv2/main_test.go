package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	vm "swyp-lang/internal/stv2"
)

func TestCLICompileRunAndExport(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "sum.swyp")
	dst := filepath.Join(dir, "sum.stv2")
	text := `fn main()->number{let n=arg(0);let s=0;while n>0{s=s+n;n=n-1;}return s;}`
	if e := os.WriteFile(src, []byte(text), 0600); e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	if e := run([]string{"-o", dst, src, "100"}, &b); e != nil {
		t.Fatal(e)
	}
	var obj map[string]any
	if e := json.Unmarshal(b.Bytes(), &obj); e != nil || obj["value"] != float64(5050) {
		t.Fatal(b.String(), e)
	}
	data, e := os.ReadFile(dst)
	if e != nil {
		t.Fatal(e)
	}
	p, e := vm.DecodeV2(data)
	if e != nil {
		t.Fatal(e)
	}
	r, e := vm.RunV2Exact(p, [8]int64{100}, 10000)
	if e != nil || r.Value != 5050 {
		t.Fatal(r, e)
	}
	if e := run([]string{"-o", dst, src, "100"}, io.Discard); e == nil {
		t.Fatal("overwrote existing file")
	}
	again, _ := os.ReadFile(dst)
	if !bytes.Equal(again, data) {
		t.Fatal("modified existing output")
	}
	if e := run([]string{"-o", src, src, "100"}, io.Discard); e == nil {
		t.Fatal("overwrote source")
	}
	unchanged, _ := os.ReadFile(src)
	if string(unchanged) != text {
		t.Fatal("modified source")
	}
}
func TestCLIInputErrorsAndBoolean(t *testing.T) {
	d := t.TempDir()
	src := filepath.Join(d, "input.swyp")
	if e := os.WriteFile(src, []byte("fn main()->bool{return arg(0)==0;}"), 0600); e != nil {
		t.Fatal(e)
	}
	cases := [][]string{nil, {"-unknown"}, {"missing.swyp"}, {src}, {src, "1", "2"}, {src, "1.2"}, {src, "9223372036854775808"}, {src, "9007199254740992"}, {"-steps", "0", src, "1"}, {"-steps", "1000001", src, "1"}}
	for _, c := range cases {
		if e := run(c, io.Discard); e == nil {
			t.Fatal("accepted", c)
		}
	}
	var b bytes.Buffer
	if e := run([]string{src, "0"}, &b); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(b.String(), `"value":true`) {
		t.Fatal(b.String())
	}
	out := filepath.Join(d, "no-output.stv2")
	if e := run([]string{"-steps", "1", "-o", out, src, "0"}, io.Discard); e == nil {
		t.Fatal("fuel should fail")
	}
	if _, e := os.Stat(out); !os.IsNotExist(e) {
		t.Fatal("failed run wrote output")
	}
	if e := os.WriteFile(src, []byte(strings.Repeat(" ", (1<<20)+1)), 0600); e != nil {
		t.Fatal(e)
	}
	if e := run([]string{src}, io.Discard); e == nil {
		t.Fatal("oversized source")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("output failed") }
func TestCLIReportsOutputError(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.swyp")
	if e := os.WriteFile(src, []byte("fn main()->number{return 1;}"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := run([]string{src}, failingWriter{}); e == nil {
		t.Fatal("lost write error")
	}
}
