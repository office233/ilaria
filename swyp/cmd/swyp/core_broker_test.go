package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	continuationwire "swyp-lang/protocol/continuation"
	"swyp-lang/protocol/effects"
)

func brokerResultLine(t *testing.T, id, status, valueType string, value []byte, code string) string {
	t.Helper()
	data, err := json.Marshal(effects.EffectResult{ProtocolVersion: effects.Version, RequestID: id, Status: status, ValueType: valueType, Value: value, ErrorCode: code})
	if err != nil {
		t.Fatal(err)
	}
	return string(data) + "\n"
}

func brokerFrames(t *testing.T, output []byte) ([]effects.EffectRequest, coreBrokerCompletion) {
	t.Helper()
	var requests []effects.EffectRequest
	var completion coreBrokerCompletion
	lines := bytes.Split(bytes.TrimSpace(output), []byte{'\n'})
	for i, line := range lines {
		if i == len(lines)-1 {
			if err := json.Unmarshal(line, &completion); err != nil {
				t.Fatalf("completion %q: %v", line, err)
			}
			if completion.Type != "completion" || completion.ProtocolVersion != effects.Version {
				t.Fatalf("invalid completion: %+v", completion)
			}
		} else {
			request, err := effects.DecodeRequest(line)
			if err != nil {
				t.Fatalf("request %q: %v", line, err)
			}
			requests = append(requests, request)
		}
	}
	return requests, completion
}

func runBrokerWithContinuationAck(t *testing.T, args []string) ([]effects.EffectRequest, continuationwire.Checkpoint, coreBrokerCompletion, error) {
	t.Helper()
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	errCh := make(chan error, 1)
	go func() {
		errCh <- coreBrokerCommand(args, inReader, outWriter)
		_ = outWriter.Close()
	}()
	defer inReader.Close()
	defer inWriter.Close()
	defer outReader.Close()

	scanner := bufio.NewScanner(outReader)
	scanner.Buffer(make([]byte, 64<<10), continuationwire.MaxMessageBytes+1)
	var requests []effects.EffectRequest
	var checkpoint continuationwire.Checkpoint
	var completion coreBrokerCompletion
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &frame); err != nil {
			t.Fatalf("decode broker frame %q: %v", line, err)
		}
		switch frame.Type {
		case "continuation":
			var err error
			checkpoint, err = continuationwire.DecodeCheckpoint(line)
			if err != nil {
				t.Fatal(err)
			}
			ack := continuationwire.Ack{
				ProtocolVersion: continuationwire.Version, Type: "continuation_ack",
				RunID: checkpoint.RunID, ModuleHash: checkpoint.ModuleHash, Entry: checkpoint.Entry,
				EffectCursor: checkpoint.EffectCursor, StateHash: checkpoint.StateHash, Status: "accepted",
			}
			raw, err := json.Marshal(ack)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := inWriter.Write(append(raw, '\n')); err != nil {
				t.Fatal(err)
			}
		case "completion":
			if err := json.Unmarshal(line, &completion); err != nil {
				t.Fatal(err)
			}
		default:
			request, err := effects.DecodeRequest(line)
			if err != nil {
				t.Fatalf("decode request %q: %v", line, err)
			}
			requests = append(requests, request)
			var response string
			switch request.Effect {
			case "clock.read":
				response = brokerResultLine(t, request.RequestID, "succeeded", "i64", []byte("5"), "")
			case "fs.read":
				response = brokerResultLine(t, request.RequestID, "succeeded", "bytes", []byte("abc"), "")
			default:
				t.Fatalf("unexpected request: %+v", request)
			}
			if _, err := io.WriteString(inWriter, response); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return requests, checkpoint, completion, <-errCh
}

func TestCoreBrokerCLIResumesReadAndClockWithoutAmbientIO(t *testing.T) {
	source := coreFixture(t, "broker.swyp", `fn size(b:bytes)->u64{return bytes_len(b);} fn f()->u64{let b:bytes=read_file("does-not-exist.txt");return size(b)+clock();} fn main(){}`)
	input := brokerResultLine(t, "run:1", "succeeded", "bytes", []byte("abc"), "") + brokerResultLine(t, "run:2", "succeeded", "i64", []byte("9007199254740993"), "")
	var output bytes.Buffer
	if err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(input), &output); err != nil {
		t.Fatal(err, output.String())
	}
	requests, completion := brokerFrames(t, output.Bytes())
	if len(requests) != 2 || requests[0].RequestID != "run:1" || requests[0].Effect != "fs.read" || requests[0].Capability != "workspace_read" || requests[0].Path != "does-not-exist.txt" || requests[1].RequestID != "run:2" || requests[1].Effect != "clock.read" || requests[1].Path != "" {
		t.Fatalf("requests=%+v", requests)
	}
	if completion.Status != "succeeded" || completion.Result == nil || completion.Result.Type != "u64" || completion.Result.Value != "9007199254740996" || completion.Steps == 0 || completion.Diagnostic != nil {
		t.Fatalf("completion=%+v", completion)
	}
	var ir bytes.Buffer
	if err := coreCommand("ir", []string{"-entry", "f", source}, &ir); err != nil {
		t.Fatal(err)
	}
	// The normal IR command uses indentation; compacting preserves module order.
	var compact bytes.Buffer
	if err := json.Compact(&compact, ir.Bytes()); err != nil {
		t.Fatal(err)
	}
	if completion.ModuleHash != coreHash(compact.Bytes()) || requests[0].ModuleHash != completion.ModuleHash || requests[1].ModuleHash != completion.ModuleHash {
		t.Fatalf("module hashes: requests=%+v completion=%+v", requests, completion)
	}
}

func TestCoreBrokerCLIProducesOwnedBytesAndSupportsPureEntry(t *testing.T) {
	for _, test := range []struct {
		source string
		input  string
		kind   string
		value  string
		calls  int
	}{
		{`fn f()->bytes{return read_file("file.txt");} fn main(){}`, brokerResultLine(t, "run:1", "succeeded", "bytes", []byte{0, 255, 42}, ""), "bytes", base64.StdEncoding.EncodeToString([]byte{0, 255, 42}), 1},
		{`fn f()->bytes{return read_file("empty.txt");} fn main(){}`, brokerResultLine(t, "run:1", "succeeded", "bytes", []byte{}, ""), "bytes", "", 1},
		{`fn f()->u64{return 42;} fn main(){}`, "", "u64", "42", 0},
	} {
		var output bytes.Buffer
		source := coreFixture(t, "program.swyp", test.source)
		if err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(test.input), &output); err != nil {
			t.Fatal(err)
		}
		requests, completion := brokerFrames(t, output.Bytes())
		if len(requests) != test.calls || completion.Status != "succeeded" || completion.Result == nil || string(completion.Result.Type) != test.kind || completion.Result.Value != test.value {
			t.Fatalf("requests=%+v completion=%+v", requests, completion)
		}
	}
}

func TestCoreBrokerCLIStopsOnDenialFailureAndUncertainty(t *testing.T) {
	source := coreFixture(t, "program.swyp", `fn f()->u64{return clock()+clock();} fn main(){}`)
	for _, status := range []string{"denied", "failed", "uncertain", "blocked"} {
		t.Run(status, func(t *testing.T) {
			var output bytes.Buffer
			input := brokerResultLine(t, "run:1", status, "i64", nil, "policy_denied")
			err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(input), &output)
			requests, completion := brokerFrames(t, output.Bytes())
			if err == nil || len(requests) != 1 || completion.Status != "failed" || completion.Result != nil || completion.Diagnostic == nil || completion.Diagnostic.Code != "effect_"+status {
				t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
			}
		})
	}
}

func TestCoreBrokerCLIRejectsMalformedMismatchedReplayedResults(t *testing.T) {
	source := coreFixture(t, "program.swyp", `fn f()->u64{return clock()+clock();} fn main(){}`)
	first := brokerResultLine(t, "run:1", "succeeded", "i64", []byte("1"), "")
	for name, input := range map[string]string{
		"wrong id":      brokerResultLine(t, "other:1", "succeeded", "i64", []byte("1"), ""),
		"wrong type":    brokerResultLine(t, "run:1", "succeeded", "bytes", []byte("1"), ""),
		"noncanonical":  brokerResultLine(t, "run:1", "succeeded", "i64", []byte("01"), ""),
		"overflow":      brokerResultLine(t, "run:1", "succeeded", "i64", []byte("9223372036854775808"), ""),
		"unknown field": strings.TrimSpace(first[:len(first)-2]) + `,"token":"forged"}` + "\n",
		"replayed":      first + first,
	} {
		t.Run(name, func(t *testing.T) {
			var output bytes.Buffer
			err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(input), &output)
			_, completion := brokerFrames(t, output.Bytes())
			if err == nil || completion.Diagnostic == nil || completion.Diagnostic.Code != "invalid_effect_result" || completion.Result != nil {
				t.Fatalf("completion=%+v err=%v", completion, err)
			}
		})
	}
}

func TestCoreBrokerCLIBoundsFuelResponseBytesAndFrames(t *testing.T) {
	source := coreFixture(t, "read.swyp", `fn f()->bytes{return read_file("a");} fn main(){}`)
	for _, test := range []struct {
		name, input, code string
		flags             []string
		calls             int
	}{
		{"fuel", "", "fuel_exhausted", []string{"--steps", "1"}, 0},
		{"byte budget", brokerResultLine(t, "run:1", "succeeded", "bytes", []byte("abc"), ""), "effect_bytes_exhausted", []string{"--max-bytes", "2"}, 1},
		{"frame budget", strings.Repeat("x", effects.MaxMessageBytes+2), "effect_transport", nil, 1},
		{"eof", "", "effect_transport", nil, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			args := append([]string{"--run-id", "run", "--entry", "f"}, test.flags...)
			args = append(args, source)
			err := coreBrokerCommand(args, strings.NewReader(test.input), &output)
			requests, completion := brokerFrames(t, output.Bytes())
			if err == nil || len(requests) != test.calls || completion.Diagnostic == nil || completion.Diagnostic.Code != test.code {
				t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
			}
		})
	}
}

func TestCoreBrokerCLIDeadlineInterruptsWaitingForResponse(t *testing.T) {
	source := coreFixture(t, "program.swyp", `fn f()->u64{return clock();} fn main(){}`)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	var output bytes.Buffer
	started := time.Now()
	err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", "--timeout", "50ms", source}, reader, &output)
	requests, completion := brokerFrames(t, output.Bytes())
	if err == nil || len(requests) != 1 || completion.Diagnostic == nil || completion.Diagnostic.Code != "timeout" || time.Since(started) > time.Second {
		t.Fatalf("requests=%+v completion=%+v elapsed=%s err=%v", requests, completion, time.Since(started), err)
	}
}

func TestCoreBrokerCLIRejectsUnsupportedProfilesAndInvalidPath(t *testing.T) {
	for _, test := range []struct {
		source, code string
	}{
		{`fn f()->u64{return random();} fn main(){}`, "unsupported_effect"},
		{`fn f()->bytes{return read_file("\xff");} fn main(){}`, "invalid_effect_path"},
		{`fn f()->bytes{return read_file("\x00");} fn main(){}`, "invalid_effect_request"},
	} {
		var output bytes.Buffer
		source := coreFixture(t, "program.swyp", test.source)
		err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(""), &output)
		requests, completion := brokerFrames(t, output.Bytes())
		if err == nil || len(requests) != 0 || completion.Diagnostic == nil || completion.Diagnostic.Code != test.code {
			t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
		}
	}
}

func TestCoreBrokerCLIRequiresBoundedRunIdentity(t *testing.T) {
	source := coreFixture(t, "program.swyp", `fn f()->u64{return 1;} fn main(){}`)
	for _, runID := range []string{"", "illegal id", strings.Repeat("a", 121)} {
		var output bytes.Buffer
		err := coreBrokerCommand([]string{"--run-id", runID, "--entry", "f", source}, strings.NewReader(""), &output)
		requests, completion := brokerFrames(t, output.Bytes())
		if err == nil || len(requests) != 0 || completion.Status != "failed" {
			t.Fatalf("run ID %q requests=%+v completion=%+v err=%v", runID, requests, completion, err)
		}
	}
}

func TestCoreBrokerCLIRejectsNullSuccessfulFileContent(t *testing.T) {
	source := coreFixture(t, "program.swyp", `fn f()->bytes{return read_file("a");} fn main(){}`)
	var output bytes.Buffer
	input := brokerResultLine(t, "run:1", "succeeded", "bytes", nil, "")
	err := coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", source}, strings.NewReader(input), &output)
	requests, completion := brokerFrames(t, output.Bytes())
	if err == nil || len(requests) != 1 || completion.Diagnostic == nil || completion.Diagnostic.Code != "invalid_effect_result" || completion.Result != nil {
		t.Fatalf("requests=%+v completion=%+v err=%v", requests, completion, err)
	}
}

func TestCoreBrokerCLIExportsImportsContinuationWithoutEffectReplay(t *testing.T) {
	source := coreFixture(t, "continuation.swyp", `fn f()->u64{return clock()+7;} fn main(){}`)
	requests, checkpoint, uninterrupted, err := runBrokerWithContinuationAck(t, []string{
		"--run-id", "run", "--entry", "f", "--continuations", source,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || checkpoint.EffectCursor != 1 || checkpoint.RunID != "run" ||
		checkpoint.ModuleHash != uninterrupted.ModuleHash || checkpoint.Entry != "f" {
		t.Fatalf("requests=%+v checkpoint=%+v completion=%+v", requests, checkpoint, uninterrupted)
	}
	wantRequestHash, err := effects.RequestHash(requests[0])
	if err != nil {
		t.Fatal(err)
	}
	wantResultHash, err := effects.ResultHash(effects.EffectResult{
		ProtocolVersion: effects.Version, RequestID: requests[0].RequestID,
		Status: "succeeded", ValueType: "i64", Value: []byte("5"), ErrorCode: "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.EffectRequestHash != wantRequestHash || checkpoint.EffectResultHash != wantResultHash {
		t.Fatalf("effect binding hashes request=%s/%s result=%s/%s",
			checkpoint.EffectRequestHash, wantRequestHash, checkpoint.EffectResultHash, wantResultHash)
	}
	if uninterrupted.Status != "succeeded" || uninterrupted.Result == nil || uninterrupted.Result.Value != "12" {
		t.Fatalf("uninterrupted=%+v", uninterrupted)
	}

	checkpointLine, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err = coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", "--resume", source}, bytes.NewReader(append(checkpointLine, '\n')), &output)
	if err != nil {
		t.Fatal(err, output.String())
	}
	resumedRequests, resumed := brokerFrames(t, output.Bytes())
	if len(resumedRequests) != 0 {
		t.Fatalf("resolved effect replayed: %+v", resumedRequests)
	}
	if resumed.Status != "succeeded" || resumed.Result == nil || resumed.Result.Value != uninterrupted.Result.Value ||
		resumed.Steps != uninterrupted.Steps || resumed.ModuleHash != uninterrupted.ModuleHash {
		t.Fatalf("resumed=%+v uninterrupted=%+v", resumed, uninterrupted)
	}
}

func TestCoreBrokerCLIRejectsContinuationMismatchAndCorruption(t *testing.T) {
	source := coreFixture(t, "continuation.swyp", `fn f()->u64{return clock()+7;} fn main(){}`)
	_, checkpoint, _, err := runBrokerWithContinuationAck(t, []string{
		"--run-id", "run", "--entry", "f", "--continuations", source,
	})
	if err != nil {
		t.Fatal(err)
	}

	for name, args := range map[string][]string{
		"run":    {"--run-id", "other", "--entry", "f", "--resume", source},
		"budget": {"--run-id", "run", "--entry", "f", "--steps", "99999", "--resume", source},
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(checkpoint)
			if err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			err = coreBrokerCommand(args, bytes.NewReader(append(raw, '\n')), &output)
			_, completion := brokerFrames(t, output.Bytes())
			if err == nil || completion.Diagnostic == nil {
				t.Fatalf("completion=%+v err=%v", completion, err)
			}
			want := "continuation_identity_mismatch"
			if name == "budget" {
				want = "continuation_policy_changed"
			}
			if completion.Diagnostic.Code != want {
				t.Fatalf("code=%s want=%s err=%v", completion.Diagnostic.Code, want, err)
			}
		})
	}

	corrupted := checkpoint
	corrupted.State = bytes.Replace(corrupted.State, []byte(`"run_id":"run"`), []byte(`"run_id":"evil"`), 1)
	if bytes.Equal(corrupted.State, checkpoint.State) {
		t.Fatal("test did not alter serialized Core continuation")
	}
	corrupted.StateHash, err = continuationwire.HashState(corrupted.State)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(corrupted)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err = coreBrokerCommand([]string{"--run-id", "run", "--entry", "f", "--resume", source}, bytes.NewReader(append(raw, '\n')), &output)
	_, completion := brokerFrames(t, output.Bytes())
	if err == nil || completion.Diagnostic == nil || completion.Diagnostic.Code != "continuation_metadata_mismatch" {
		t.Fatalf("completion=%+v err=%v", completion, err)
	}
}
