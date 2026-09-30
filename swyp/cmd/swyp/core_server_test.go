package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestCoreServerMultipleRequestsAndShutdown(t *testing.T) {
	input := strings.NewReader(
		`{"id":"a","action":"build","args":["-entry","main"]}` + "\n" +
			`{"id":"b","action":"build","args":["fail"]}` + "\n" +
			`{"id":"r","action":"run","args":["x.swyp"]}` + "\n" +
			`{"id":"k","action":"check","args":["x.swyp"]}` + "\n" +
			`{"id":"e","action":"eval","source":"fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}","entry":"add","profile":"turbo","values":["20","22"]}` + "\n" +
			`{"id":"c","action":"shutdown"}` + "\n",
	)
	var output bytes.Buffer
	builds := 0
	build := func(args []string, out io.Writer) error {
		builds++
		if len(args) == 1 && args[0] == "fail" {
			return errors.New("boom")
		}
		_, _ = io.WriteString(out, "built")
		return nil
	}
	coreCalls := 0
	core := func(kind string, args []string, out io.Writer) error {
		coreCalls++
		_, _ = io.WriteString(out, kind)
		return nil
	}
	if err := coreServer(input, &output, build, core); err != nil {
		t.Fatal(err)
	}
	if builds != 2 {
		t.Fatalf("builds=%d want 2", builds)
	}
	if coreCalls != 2 {
		t.Fatalf("core calls=%d want 2", coreCalls)
	}
	dec := json.NewDecoder(&output)
	var got []coreServerResponse
	for dec.More() {
		var response coreServerResponse
		if err := dec.Decode(&response); err != nil {
			t.Fatal(err)
		}
		got = append(got, response)
	}
	if len(got) != 6 || got[0].Status != "ok" || got[1].Status != "error" || got[2].Output != "core-run" || got[3].Output != "ir" || !strings.Contains(got[4].Output, `"value":{"type":"i64","value":"42"}`) || got[5].Status != "bye" {
		t.Fatalf("responses=%+v", got)
	}
}

func TestCoreServerEvalCacheInvalidatesOnSourceChange(t *testing.T) {
	runtime := newCoreServerRuntime()
	base := coreServerRequest{
		Action:  "eval",
		File:    "buffer.swyp",
		Entry:   "answer",
		Profile: "turbo",
		Source:  "fn answer()->i64{return 1;} fn main(){}",
	}
	one, err := runtime.eval(base)
	if err != nil || !strings.Contains(one, `"value":"1"`) {
		t.Fatalf("one=%q err=%v", one, err)
	}
	if len(runtime.programs) != 1 {
		t.Fatalf("cache size=%d", len(runtime.programs))
	}
	base.Source = "fn answer()->i64{return 2;} fn main(){}"
	two, err := runtime.eval(base)
	if err != nil || !strings.Contains(two, `"value":"2"`) {
		t.Fatalf("two=%q err=%v", two, err)
	}
	if len(runtime.programs) != 1 {
		t.Fatalf("cache should replace same file/entry, size=%d", len(runtime.programs))
	}
}

func TestCoreServerRejectsMalformedAndUnknown(t *testing.T) {
	input := strings.NewReader("{bad}\n" + `{"id":"x","action":"wat"}` + "\n")
	var output bytes.Buffer
	if err := coreServer(input, &output, func([]string, io.Writer) error { return nil }, func(string, []string, io.Writer) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "invalid request JSON") || !strings.Contains(output.String(), "unknown action") {
		t.Fatalf("output=%q", output.String())
	}
}

func TestCoreServerOversizedLineRecovery(t *testing.T) {
	oversizedLine := strings.Repeat(" ", maxCoreServerLine+100) + "\n"
	validEval := `{"id":"ok1","action":"eval","source":"fn main(){} fn f()->i64{return 42;}","entry":"f","profile":"turbo"}` + "\n"
	shutdown := `{"id":"bye","action":"shutdown"}` + "\n"

	input := strings.NewReader(oversizedLine + validEval + shutdown)
	var output bytes.Buffer
	if err := coreServer(input, &output, func([]string, io.Writer) error { return nil }, func(string, []string, io.Writer) error { return nil }); err != nil {
		t.Fatalf("coreServer unexpected error: %v", err)
	}

	dec := json.NewDecoder(&output)
	var resp1, resp2, resp3 coreServerResponse
	if err := dec.Decode(&resp1); err != nil {
		t.Fatalf("decode resp1: %v", err)
	}
	if resp1.Status != "error" || !strings.Contains(resp1.Error, "exceeds maximum size") {
		t.Fatalf("resp1 unexpected: %+v", resp1)
	}

	if err := dec.Decode(&resp2); err != nil {
		t.Fatalf("decode resp2: %v", err)
	}
	if resp2.ID != "ok1" || resp2.Status != "ok" || !strings.Contains(resp2.Output, `"42"`) {
		t.Fatalf("resp2 unexpected: %+v", resp2)
	}

	if err := dec.Decode(&resp3); err != nil {
		t.Fatalf("decode resp3: %v", err)
	}
	if resp3.ID != "bye" || resp3.Status != "bye" {
		t.Fatalf("resp3 unexpected: %+v", resp3)
	}
}

func TestCoreServerEvalCacheEviction(t *testing.T) {
	runtime := newCoreServerRuntime()
	totalPrograms := maxCoreServerPrograms + 2
	for i := 0; i < totalPrograms; i++ {
		req := coreServerRequest{
			Action:  "eval",
			File:    fmt.Sprintf("prog_%d.swyp", i),
			Entry:   "ans",
			Profile: "turbo",
			Source:  fmt.Sprintf("fn ans()->i64{return %d;} fn main(){}", i),
		}
		out, err := runtime.eval(req)
		if err != nil {
			t.Fatalf("eval program %d failed: %v", i, err)
		}
		want := fmt.Sprintf(`"value":"%d"`, i)
		if !strings.Contains(out, want) {
			t.Fatalf("eval program %d output %q does not contain %s", i, out, want)
		}
	}
	if len(runtime.programs) != maxCoreServerPrograms {
		t.Fatalf("cache size=%d want max %d", len(runtime.programs), maxCoreServerPrograms)
	}
	// The first 2 programs (prog_0.swyp and prog_1.swyp) must have been evicted
	key0 := "prog_0.swyp\x00ans\x00turbo"
	key1 := "prog_1.swyp\x00ans\x00turbo"
	if _, ok := runtime.programs[key0]; ok {
		t.Fatalf("expected program 0 to be evicted from cache")
	}
	if _, ok := runtime.programs[key1]; ok {
		t.Fatalf("expected program 1 to be evicted from cache")
	}
	// The latest program must still be in cache
	lastKey := fmt.Sprintf("prog_%d.swyp\x00ans\x00turbo", totalPrograms-1)
	if _, ok := runtime.programs[lastKey]; !ok {
		t.Fatalf("expected program %d to be in cache", totalPrograms-1)
	}
}

func TestCoreServerBuildWarningSurfaced(t *testing.T) {
	build := func(args []string, out io.Writer) error {
		if wr, ok := out.(warningReceiver); ok {
			wr.SetWarning("store Core AOT cache artifact: disk full")
		}
		_, _ = io.WriteString(out, "Built Core AOT binary.exe (fast)")
		return nil
	}
	input := strings.NewReader(`{"id":"b1","action":"build","args":["-o","out.exe","test.swyp"]}` + "\n")
	var output bytes.Buffer
	if err := coreServer(input, &output, build, func(string, []string, io.Writer) error { return nil }); err != nil {
		t.Fatalf("coreServer error: %v", err)
	}
	var resp coreServerResponse
	if err := json.NewDecoder(&output).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "ok" {
		t.Fatalf("expected status ok, got %q", resp.Status)
	}
	if resp.Error != "" {
		t.Fatalf("expected no error, got %q", resp.Error)
	}
	if !strings.Contains(resp.Warning, "disk full") {
		t.Fatalf("expected warning with 'disk full', got %q", resp.Warning)
	}
}
