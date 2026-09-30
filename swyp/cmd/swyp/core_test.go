package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"swyp-lang/internal/coreir"
)

const coreCLISource = `fn square(x:i64)->i64{return x*x;} fn next(x:i64)->i64{return x+1;} fn main(){}`
const coreCLIContract = `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-4","max":"4"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"mul","args":[{"var":"x"},{"var":"x"}]}]}],"max_steps":100}`

func coreFixture(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func coreJSON(t *testing.T, b *bytes.Buffer) map[string]json.RawMessage {
	t.Helper()
	var r map[string]json.RawMessage
	d := json.NewDecoder(b)
	if err := d.Decode(&r); err != nil {
		t.Fatal(err, b.String())
	}
	if err := d.Decode(new(any)); err != io.EOF {
		t.Fatal("multiple JSON documents", err)
	}
	return r
}

func TestCoreCLIExactValuesAndVerifiedContracts(t *testing.T) {
	source := coreFixture(t, "program.swyp", coreCLISource)
	contract := coreFixture(t, "contract.json", coreCLIContract)
	var b bytes.Buffer
	if err := coreCommand("core-run", []string{"-entry", "next", source, "9007199254740993"}, &b); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Status string `json:"status"`
		Result struct {
			Value coreir.Literal `json:"value"`
		} `json:"result"`
		IRSHA256 string `json:"ir_sha256"`
	}
	if err := json.Unmarshal(b.Bytes(), &result); err != nil || result.Status != "ok" || result.Result.Value.Type != coreir.I64 || result.Result.Value.Value != "9007199254740994" || len(result.IRSHA256) != 64 {
		t.Fatal(b.String(), err)
	}
	b.Reset()
	if err := coreCommand("core-run", []string{"-profile", "fast", "-entry", "next", source, "9007199254740993"}, &b); err != nil {
		t.Fatal(err)
	}
	var fastResult struct {
		Status  string `json:"status"`
		Profile string `json:"profile"`
		Result  struct {
			Value coreir.Literal `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(b.Bytes(), &fastResult); err != nil || fastResult.Status != "ok" || fastResult.Profile != "fast" || fastResult.Result.Value.Value != "9007199254740994" {
		t.Fatal(b.String(), err)
	}
	b.Reset()
	if err := coreCommand("verify", []string{"-contract", contract, source}, &b); err != nil {
		t.Fatal(err)
	}
	var report coreir.Verification
	if err := json.Unmarshal(b.Bytes(), &report); err != nil || report.Status != "exhaustive" || report.CasesChecked != 9 || len(report.SourceSHA256) != 64 || len(report.ContractSHA256) != 64 || len(report.IRSHA256) != 64 {
		t.Fatal(b.String(), err)
	}
	bad := coreFixture(t, "bad.swyp", `fn square(x:i64)->i64{return x;} fn main(){}`)
	b.Reset()
	if err := coreCommand("verify", []string{"-contract", contract, bad}, &b); err == nil {
		t.Fatal("counterexample exited successfully")
	}
	if err := json.Unmarshal(b.Bytes(), &report); err != nil || report.Status != "counterexample" {
		t.Fatal(b.String(), err)
	}
	coreJSON(t, &b)
	b.Reset()
	if err := coreCommand("verify", []string{"-contract", contract, "-steps", "1", source}, &b); err == nil {
		t.Fatal("unknown verification exited successfully")
	}
	if err := json.Unmarshal(b.Bytes(), &report); err != nil || report.Status != "unknown" {
		t.Fatal(b.String(), err)
	}
}
func TestCoreCLIExportIsExclusiveAndRoundTrips(t *testing.T) {
	source := coreFixture(t, "program.swyp", coreCLISource)
	path := filepath.Join(t.TempDir(), "program.core.json")
	var b bytes.Buffer
	if err := coreCommand("ir", []string{"-entry", "next", "-o", path, source}, &b); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	b.Reset()
	if err := coreCommand("ir", []string{"-entry", "next", "-o", path, source}, &b); err == nil {
		t.Fatal("overwrote existing IR")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("existing file changed", err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	b.Reset()
	if err := coreCommand("core-exec", []string{"-entry", "next", path, "9007199254740993"}, &b); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "9007199254740994") {
		t.Fatal(b.String())
	}
	m, err := coreir.Decode(before)
	if err != nil {
		t.Fatal(err)
	}
	m.Functions[0].Blocks[0].Instructions[0].Dest = 99999
	invalid, _ := json.Marshal(m)
	bad := coreFixture(t, "invalid.json", string(invalid))
	b.Reset()
	if err := coreCommand("core-exec", []string{"-entry", "next", bad, "1"}, &b); err == nil {
		t.Fatal("invalid IR accepted")
	}
	if !strings.Contains(b.String(), "invalid_ir") {
		t.Fatal(b.String())
	}
}
func TestCoreCLIRejectsInvalidInputsWithJSON(t *testing.T) {
	source := coreFixture(t, "program.swyp", coreCLISource)
	for _, args := range [][]string{
		nil, {"-entry", "next", source}, {"-entry", "next", source, "1.5"}, {"-entry", "next", source, "9223372036854775808"},
		{"-entry", "next", "-steps", "0", source, "1"}, {"-entry", "next", "-timeout", "0s", source, "1"}, {"-entry", "next", "-profile", "warp", source, "1"}, {"-entry", "next", source, "1", "2"},
	} {
		var b bytes.Buffer
		if err := coreCommand("core-run", args, &b); err == nil {
			t.Fatal("accepted", args)
		}
		r := coreJSON(t, &b)
		if string(r["status"]) != `"error"` || r["diagnostic"] == nil {
			t.Fatal(r)
		}
	}
	for _, data := range []string{`{"version":1,"version":2}`, `{"version":1,"typo":true}`, `null`, strings.Repeat(" ", 65537)} {
		contract := coreFixture(t, "bad.json", data)
		var b bytes.Buffer
		if err := coreCommand("verify", []string{"-contract", contract, source}, &b); err == nil {
			t.Fatal("accepted malformed contract")
		}
		coreJSON(t, &b)
	}
	oversized := coreFixture(t, "large.swyp", strings.Repeat(" ", coreir.MaxBytes+1))
	var b bytes.Buffer
	if err := coreCommand("ir", []string{oversized}, &b); err == nil {
		t.Fatal("oversized source accepted")
	}
}

type coreBrokenWriter struct{}

func (coreBrokenWriter) Write([]byte) (int, error) { return 0, errors.New("output unavailable") }
func TestCoreCLIReportsOutputErrors(t *testing.T) {
	source := coreFixture(t, "program.swyp", coreCLISource)
	if err := coreCommand("core-run", []string{"-entry", "next", source, "1"}, coreBrokenWriter{}); err == nil {
		t.Fatal("lost output error")
	}
}
func TestCoreCLIFreshExecutableWithoutSourceOrToolchain(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "swyp-core.exe")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	source := filepath.Join(dir, "input.swyp")
	module := filepath.Join(dir, "output.core.json")
	if err := os.WriteFile(source, []byte(coreCLISource), 0600); err != nil {
		t.Fatal(err)
	}
	compile := exec.CommandContext(ctx, binary, "ir", "-entry", "next", "-o", module, source)
	if out, err := compile.CombinedOutput(); err != nil {
		t.Fatalf("export: %v\n%s", err, out)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	run := exec.CommandContext(ctx, binary, "core-exec", "-entry", "next", module, "9007199254740993")
	for _, item := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(item), "PATH=") {
			run.Env = append(run.Env, item)
		}
	}
	run.Env = append(run.Env, "PATH="+dir)
	out, err := run.CombinedOutput()
	if err != nil || !strings.Contains(string(out), `"value":"9007199254740994"`) {
		t.Fatalf("source-free execution: %v\n%s", err, out)
	}
	t.Logf("real executable with deleted source and toolchain-free PATH: %s", out)
}
