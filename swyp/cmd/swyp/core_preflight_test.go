package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/protocol/effects"
)

func decodePreflightPlan(t *testing.T, output *bytes.Buffer) effects.EffectPlan {
	t.Helper()
	var plan effects.EffectPlan
	decoder := json.NewDecoder(output)
	if err := decoder.Decode(&plan); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		t.Fatalf("extra preflight frame: %v", err)
	}
	return plan
}

func TestCorePreflightFreezesCanonicalSnapshotForBrokerExecution(t *testing.T) {
	source := coreFixture(t, "source.swyp", `fn size(b:bytes)->u64{return bytes_len(b);} fn f()->u64{let b:bytes=read_file("not-opened.txt");return size(b)+clock();} fn main(){}`)
	snapshot := filepath.Join(t.TempDir(), "snapshot.core.json")
	var output bytes.Buffer
	if err := corePreflightCommand([]string{"--entry", "f", "-o", snapshot, source}, &output); err != nil {
		t.Fatal(err, output.String())
	}
	plan := decodePreflightPlan(t, &output)
	if plan.ProtocolVersion != effects.Version || plan.Entry != "f" || !reflect.DeepEqual(plan.Effects, []string{"clock.read", "fs.read"}) || !reflect.DeepEqual(plan.CapabilityBindings, map[string]string{"f/clock.read": "clock_read", "f/fs.read": "workspace_read"}) {
		t.Fatalf("plan=%+v", plan)
	}
	data, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := json.Marshal(module)
	if err != nil || !bytes.Equal(data, canonical) || coreHash(data) != plan.ModuleHash {
		t.Fatalf("noncanonical snapshot or hash mismatch: %v", err)
	}
	// Changing and deleting the source cannot change the pinned broker snapshot.
	if err := os.WriteFile(source, []byte(`fn f()->u64{return random();} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	input := brokerResultLine(t, "pinned:1", "succeeded", "bytes", []byte("abc"), "") + brokerResultLine(t, "pinned:2", "succeeded", "i64", []byte("41"), "")
	if err := coreBrokerCommand([]string{"--ir", "--run-id", "pinned", "--entry", "f", snapshot}, strings.NewReader(input), &output); err != nil {
		t.Fatal(err, output.String())
	}
	requests, completion := brokerFrames(t, output.Bytes())
	if len(requests) != 2 || requests[0].ModuleHash != plan.ModuleHash || requests[1].ModuleHash != plan.ModuleHash || completion.ModuleHash != plan.ModuleHash || completion.Result == nil || completion.Result.Value != "44" || completion.Status != "succeeded" {
		t.Fatalf("requests=%+v completion=%+v", requests, completion)
	}
}

func TestCorePreflightDoesNotExecuteTrapsAndEmitsEmptyCollections(t *testing.T) {
	source := coreFixture(t, "trap.swyp", `fn f(x:u64)->u64{return x/0;} fn main(){}`)
	var output bytes.Buffer
	if err := corePreflightCommand([]string{"--entry", "f", source}, &output); err != nil {
		t.Fatal(err)
	}
	encoded := output.String()
	plan := decodePreflightPlan(t, &output)
	if plan.Effects == nil || plan.CapabilityBindings == nil || len(plan.Effects) != 0 || len(plan.CapabilityBindings) != 0 || !strings.Contains(encoded, `"effects":[]`) || !strings.Contains(encoded, `"capability_bindings":{}`) {
		t.Fatalf("pure plan=%+v encoded=%s", plan, encoded)
	}
}

func TestCorePreflightRejectsUnsupportedEffectsBeforePublication(t *testing.T) {
	source := coreFixture(t, "unsupported.swyp", `fn f()->u64{return random();} fn main(){}`)
	snapshot := filepath.Join(t.TempDir(), "absent.core.json")
	var output bytes.Buffer
	err := corePreflightCommand([]string{"--entry", "f", "-o", snapshot, source}, &output)
	if err == nil {
		t.Fatal("unsupported preflight succeeded")
	}
	var failure struct {
		Status     string             `json:"status"`
		Diagnostic *coreir.Diagnostic `json:"diagnostic"`
	}
	if err := json.Unmarshal(output.Bytes(), &failure); err != nil || failure.Status != "failed" || failure.Diagnostic == nil || failure.Diagnostic.Code != "unsupported_effect" {
		t.Fatalf("failure=%+v output=%s err=%v", failure, output.String(), err)
	}
	if _, err := os.Lstat(snapshot); !os.IsNotExist(err) {
		t.Fatalf("published rejected snapshot: %v", err)
	}
}

func TestCorePreflightNeverOverwritesExistingSnapshotOrSource(t *testing.T) {
	source := coreFixture(t, "pure.swyp", `fn f()->u64{return 42;} fn main(){}`)
	snapshot := coreFixture(t, "existing.core.json", "preserved")
	for _, destination := range []string{snapshot, source} {
		before, err := os.ReadFile(destination)
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := corePreflightCommand([]string{"--entry", "f", "-o", destination, source}, &output); err == nil {
			t.Fatal("overwrote existing snapshot or source")
		}
		after, err := os.ReadFile(destination)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("destination changed: %v", err)
		}
	}
}

func TestCorePreflightRejectsWireIncompatibleIdentifiersBeforePublication(t *testing.T) {
	longName := strings.Repeat("a", 65)
	for _, test := range []struct {
		source, entry string
	}{
		{"fn " + longName + "()->u64{return 1;} fn main(){}", longName},
		{"fn " + longName + "()->u64{return clock();} fn f()->u64{return " + longName + "();} fn main(){}", "f"},
	} {
		source := coreFixture(t, "identity.swyp", test.source)
		snapshot := filepath.Join(t.TempDir(), "absent.core.json")
		var output bytes.Buffer
		err := corePreflightCommand([]string{"--entry", test.entry, "-o", snapshot, source}, &output)
		var failure struct {
			Diagnostic *coreir.Diagnostic `json:"diagnostic"`
		}
		if err == nil || json.Unmarshal(output.Bytes(), &failure) != nil || failure.Diagnostic == nil || failure.Diagnostic.Code != "invalid_effect_plan" {
			t.Fatalf("output=%s err=%v", output.String(), err)
		}
		if _, err := os.Lstat(snapshot); !os.IsNotExist(err) {
			t.Fatalf("incompatible snapshot published: %v", err)
		}
	}
}

func TestCorePreflightRejectsOversizedCanonicalSnapshot(t *testing.T) {
	var program strings.Builder
	var callees []string
	for i := 0; i < 16; i++ {
		fmt.Fprintf(&program, "fn g%d()->u64{let x:u64=0;%sreturn x;}", i, strings.Repeat(`x=x+1;`, 100))
		callees = append(callees, fmt.Sprintf("g%d()", i))
	}
	program.WriteString("fn f()->u64{return " + strings.Join(callees, "+") + ";} fn main(){}")
	source := coreFixture(t, strings.Repeat("x", 160)+".swyp", program.String())
	snapshot := filepath.Join(t.TempDir(), "oversized.core.json")
	var output bytes.Buffer
	err := corePreflightCommand([]string{"--entry", "f", "-o", snapshot, source}, &output)
	if err == nil {
		t.Fatal("oversized canonical snapshot accepted")
	}
	var failure struct {
		Diagnostic *coreir.Diagnostic `json:"diagnostic"`
	}
	if decodeErr := json.Unmarshal(output.Bytes(), &failure); decodeErr != nil || failure.Diagnostic == nil || failure.Diagnostic.Code != "invalid_snapshot" {
		t.Fatalf("output=%s err=%v decodeErr=%v", output.String(), err, decodeErr)
	}
	if _, err := os.Lstat(snapshot); !os.IsNotExist(err) {
		t.Fatalf("oversized snapshot published: %v", err)
	}
}

func TestCoreBrokerRejectsWireIncompatibleCalleeBeforeEarlierEffect(t *testing.T) {
	longName := strings.Repeat("a", 65)
	source := coreFixture(t, "late-identity.swyp", `fn f()->u64{let b:bytes=read_file("input.txt");return `+longName+`();} fn `+longName+`()->u64{return clock();} fn main(){}`)
	snapshot := filepath.Join(t.TempDir(), "snapshot.core.json")
	var exported bytes.Buffer
	if err := coreCommand("ir", []string{"--entry", "f", "-o", snapshot, source}, &exported); err != nil {
		t.Fatal(err, exported.String())
	}
	for _, test := range []struct {
		name, input string
		ir          bool
	}{
		{"source", source, false},
		{"snapshot", snapshot, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			args := []string{"--run-id", "invalid-callee", "--entry", "f"}
			if test.ir {
				args = append(args, "--ir")
			}
			args = append(args, test.input)
			var output bytes.Buffer
			err := coreBrokerCommand(args, strings.NewReader(""), &output)
			requests, completion := brokerFrames(t, output.Bytes())
			if err == nil || len(requests) != 0 || completion.Steps != 0 || completion.Diagnostic == nil || completion.Diagnostic.Code != "invalid_effect_plan" {
				t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
			}
		})
	}
}

func TestCoreBrokerIRRejectsMalformedSnapshotWithoutGuestExecution(t *testing.T) {
	for name, input := range map[string]string{
		"unknown field": `{"version":1,"functions":[],"authority":"forged"}`,
		"duplicate":     `{"version":1,"Version":1,"functions":[]}`,
		"trailing":      `{"version":1,"functions":[]} {}`,
		"source":        `fn main(){}`,
		"oversized":     strings.Repeat("x", coreir.MaxBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			snapshot := coreFixture(t, "invalid.core.json", input)
			var output bytes.Buffer
			err := coreBrokerCommand([]string{"--ir", "--run-id", "invalid", snapshot}, strings.NewReader(""), &output)
			requests, completion := brokerFrames(t, output.Bytes())
			if err == nil || len(requests) != 0 || completion.Status != "failed" || completion.Result != nil {
				t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
			}
		})
	}
}

func TestCoreBrokerIRCanonicalizesFormattingWithoutChangingModuleHash(t *testing.T) {
	source := coreFixture(t, "pure.swyp", `fn f(x:i64)->i64{return x+1;} fn main(){}`)
	snapshot := filepath.Join(t.TempDir(), "pure.core.json")
	var output bytes.Buffer
	if err := corePreflightCommand([]string{"--entry", "f", "-o", snapshot, source}, &output); err != nil {
		t.Fatal(err)
	}
	plan := decodePreflightPlan(t, &output)
	data, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, data, "", "  "); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshot, formatted.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := coreBrokerCommand([]string{"--ir", "--run-id", "pure", "--entry", "f", snapshot, "9007199254740993"}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	requests, completion := brokerFrames(t, output.Bytes())
	if len(requests) != 0 || completion.ModuleHash != plan.ModuleHash || completion.Result == nil || completion.Result.Value != "9007199254740994" {
		t.Fatalf("requests=%+v completion=%+v", requests, completion)
	}
}
