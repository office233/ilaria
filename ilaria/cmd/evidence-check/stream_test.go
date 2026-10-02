package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"ilaria/runtime/evidence"
)

func (fixture cliFixture) envelope() streamEnvelope {
	return streamEnvelope{ProtocolVersion: evidence.ProtocolVersion, Request: fixture.request,
		Result: fixture.result, Receipt: fixture.receipt, Expected: fixture.expected}
}

func jsonLine(t testing.TB, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return append(raw, '\n')
}

func readResponses(t *testing.T, raw []byte) []streamResponse {
	t.Helper()
	var responses []streamResponse
	for _, line := range bytes.Split(bytes.TrimSuffix(raw, []byte{'\n'}), []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var response streamResponse
		if err := evidence.DecodeStrict(line, &response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	return responses
}

func TestStreamCorrelatesFileAndClockEvidenceWithoutPrivatePayloads(t *testing.T) {
	file := newFixture(t)
	file.request.Path = "目录/😀<&>.txt"
	file.sign(t)
	clock := file
	clock.request.RequestID, clock.request.Effect, clock.request.Capability, clock.request.Path = "request:2", "clock.read", "clock_read", ""
	clock.result.RequestID, clock.result.ValueType, clock.result.Value = "request:2", "i64", []byte("1799999999000")
	clock.receipt.RequestID, clock.receipt.Effect, clock.receipt.Capability, clock.receipt.NodeID = "request:2", "clock.read", "clock_read", "node:2"
	clock.expected.NodeID = "node:2"
	clock.sign(t)
	_, paths := file.write(t)
	input := append(jsonLine(t, file.envelope()), jsonLine(t, clock.envelope())...)
	var output bytes.Buffer
	if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	responses := readResponses(t, output.Bytes())
	if len(responses) != 2 {
		t.Fatalf("responses=%+v", responses)
	}
	for i, response := range responses {
		if response.ProtocolVersion != 1 || !response.Accepted || response.ErrorCode != "" || response.Observation == nil ||
			!response.Observation.Verified || response.Observation.TrainingEligible ||
			response.Observation.RequestID != response.RequestID || response.Observation.Purpose != "execution_evidence_only" {
			t.Fatalf("response %d=%+v", i, response)
		}
	}
	if responses[0].RequestID != "request:1" || responses[1].RequestID != "request:2" || responses[1].Observation.ValueType != "i64" {
		t.Fatalf("incorrect correlation/types %+v", responses)
	}
	for _, private := range []string{"private payload", "cHJpdmF0ZSBwYXlsb2Fk", "目录", "1799999999000"} {
		if strings.Contains(output.String(), private) {
			t.Fatalf("private payload/path appeared in response: %q", private)
		}
	}
}

func TestStreamSemanticRejectionDoesNotDesynchronizeNextRequest(t *testing.T) {
	for _, kind := range []string{"unknown_signer", "revoked", "wrong_executor", "wrong_fence", "privacy", "tampered_result", "tampered_signature", "negative", "nonterminal", "unsupported_protocol"} {
		t.Run(kind, func(t *testing.T) {
			valid := newFixture(t)
			invalid := valid
			invalid.request.RequestID, invalid.result.RequestID, invalid.receipt.RequestID = "request:bad", "request:bad", "request:bad"
			invalid.sign(t)
			envelope := invalid.envelope()
			switch kind {
			case "unknown_signer":
				envelope.Receipt.SignerKeyID = "self-issued"
			case "revoked":
				key := valid.registry.Keys["key:1"]
				key.Revoked = true
				valid.registry.Keys["key:1"] = key
			case "wrong_executor":
				key := valid.registry.Keys["key:1"]
				key.ExecutorID = "another-executor"
				valid.registry.Keys["key:1"] = key
			case "wrong_fence":
				envelope.Expected.Fence++
			case "privacy":
				invalid.receipt.PrivacyClass = "public"
				invalid.sign(t)
				envelope = invalid.envelope()
			case "tampered_result":
				envelope.Result.Value = []byte("tampered result")
			case "tampered_signature":
				envelope.Receipt.Signature = append([]byte{}, envelope.Receipt.Signature...)
				envelope.Receipt.Signature[0] ^= 1
			case "negative":
				invalid.result.Status, invalid.receipt.Status = "denied", "denied"
				invalid.result.ErrorCode, invalid.receipt.ErrorCode, invalid.result.Value = "policy_denied", "policy_denied", nil
				invalid.sign(t)
				envelope = invalid.envelope()
			case "nonterminal":
				invalid.result.Status, invalid.receipt.Status = "started", "started"
				invalid.sign(t)
				envelope = invalid.envelope()
			case "unsupported_protocol":
				envelope.ProtocolVersion = 2
			}
			_, paths := valid.write(t)
			input := append(jsonLine(t, envelope), jsonLine(t, valid.envelope())...)
			var output bytes.Buffer
			if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, bytes.NewReader(input), &output); err != nil {
				t.Fatal("semantic rejection terminated stream", err)
			}
			responses := readResponses(t, output.Bytes())
			if len(responses) != 2 || responses[0].RequestID != "request:bad" || responses[0].Accepted ||
				responses[0].ErrorCode == "" || responses[0].Observation != nil || responses[1].RequestID != "request:1" {
				t.Fatalf("invalid semantic response %+v", responses)
			}
			wantSecondAccepted := kind != "revoked" && kind != "wrong_executor"
			if responses[1].Accepted != wantSecondAccepted {
				t.Fatalf("next request acceptance=%v wanted=%v", responses[1].Accepted, wantSecondAccepted)
			}
		})
	}
}

func TestStreamMalformedJSONAndLimitsAreFatalBeforeFollowingRequest(t *testing.T) {
	valid := newFixture(t)
	line := string(jsonLine(t, valid.envelope()))
	largePayload := valid.envelope()
	largePayload.Result.Value = make([]byte, evidence.MaxValueBytes+1)
	longID := valid.envelope()
	longID.Request.RequestID = strings.Repeat("a", evidence.MaxIdentifierBytes+1)
	longPath := valid.envelope()
	longPath.Request.Path = strings.Repeat("p", evidence.MaxPathBytes+1)
	for name, invalid := range map[string][]byte{
		"unknown_field":       []byte(strings.Replace(line, `"protocol_version":1`, `"protocol_version":1,"grant":"injected"`, 1)),
		"aliased_field":       []byte(strings.Replace(line, `"expected"`, `"Expected"`, 1)),
		"duplicate_field":     []byte(strings.Replace(line, `"protocol_version":1`, `"protocol_version":1,"protocol_version":1`, 1)),
		"missing_context":     []byte(`{"protocol_version":1}` + "\n"),
		"null_context":        []byte(strings.Replace(line, `"task_id":"task:1"`, `"task_id":null`, 1)),
		"lossy_unicode":       []byte(strings.Replace(line, `"private-input.txt"`, `"\ud800"`, 1)),
		"invalid_utf8":        {'{', '"', 0xff, '"', ':', '1', '}', '\n'},
		"noncanonical_base64": []byte(strings.Replace(line, `"cHJpdmF0ZSBwYXlsb2Fk"`, `"cHJpdmF0\nZSBwYXlsb2Fk"`, 1)),
		"trailing_document":   []byte(strings.TrimSpace(line) + "{}\n"),
		"empty_line":          []byte{'\n'},
		"overline":            append(bytes.Repeat([]byte{'x'}, evidence.MaxJSONBytes+3), '\n'),
		"decoded_payload":     jsonLine(t, largePayload),
		"long_correlation_id": jsonLine(t, longID),
		"long_path":           jsonLine(t, longPath),
	} {
		t.Run(name, func(t *testing.T) {
			_, paths := valid.write(t)
			input := append(append([]byte{}, invalid...), []byte(line)...)
			var output bytes.Buffer
			if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, bytes.NewReader(input), &output); err == nil || output.Len() != 0 {
				t.Fatalf("malformed/overlimit input continued: %v %q", err, output.String())
			}
		})
	}
}

type callbackWriter struct {
	bytes.Buffer
	afterWrite func()
}

func (writer *callbackWriter) Write(raw []byte) (int, error) {
	n, err := writer.Buffer.Write(raw)
	if writer.afterWrite != nil {
		writer.afterWrite()
		writer.afterWrite = nil
	}
	return n, err
}

func TestStreamLoadsTrustSnapshotOnceAndReloadRequiresNewProcess(t *testing.T) {
	fixture := newFixture(t)
	_, paths := fixture.write(t)
	revoked := fixture.registry
	key := revoked.Keys["key:1"]
	key.Revoked = true
	revoked.Keys["key:1"] = key
	revokedJSON, err := json.Marshal(revoked)
	if err != nil {
		t.Fatal(err)
	}
	output := &callbackWriter{afterWrite: func() {
		if err := os.WriteFile(paths["keys"], revokedJSON, 0600); err != nil {
			t.Fatal(err)
		}
	}}
	input := append(jsonLine(t, fixture.envelope()), jsonLine(t, fixture.envelope())...)
	if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, bytes.NewReader(input), output); err != nil {
		t.Fatal(err)
	}
	responses := readResponses(t, output.Bytes())
	if len(responses) != 2 || !responses[0].Accepted || !responses[1].Accepted {
		t.Fatalf("active trust snapshot changed %+v", responses)
	}
	var reloaded bytes.Buffer
	if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, bytes.NewReader(jsonLine(t, fixture.envelope())), &reloaded); err != nil {
		t.Fatal(err)
	}
	if responses := readResponses(t, reloaded.Bytes()); len(responses) != 1 || responses[0].Accepted || responses[0].Observation != nil {
		t.Fatalf("explicit registry reload did not apply revocation %+v", responses)
	}
}

func TestStreamResponsesArriveBeforeEOFAndEOFStopsCleanly(t *testing.T) {
	fixture := newFixture(t)
	_, paths := fixture.write(t)
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	t.Cleanup(func() {
		_ = inputReader.Close()
		_ = inputWriter.Close()
		_ = outputReader.Close()
		_ = outputWriter.Close()
	})
	done := make(chan error, 1)
	go func() { done <- runWithInput([]string{"--stream", "--keys", paths["keys"]}, inputReader, outputWriter) }()
	go func() { _, _ = inputWriter.Write(jsonLine(t, fixture.envelope())) }()
	responded := make(chan streamResponse, 1)
	go func() {
		var response streamResponse
		if err := json.NewDecoder(outputReader).Decode(&response); err == nil {
			responded <- response
		}
	}()
	select {
	case response := <-responded:
		if !response.Accepted || response.RequestID != "request:1" {
			t.Fatalf("live response %+v", response)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream buffered response until EOF")
	}
	_ = inputWriter.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("clean EOF failed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not stop after EOF")
	}
	var emptyOutput bytes.Buffer
	if err := runWithInput([]string{"--stream", "--keys", paths["keys"]}, strings.NewReader(""), &emptyOutput); err != nil || emptyOutput.Len() != 0 {
		t.Fatalf("empty stream failed or produced output: %v %q", err, emptyOutput.String())
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("input unavailable") }

func TestStreamArgumentTransportErrorsAndUnterminatedFinalLine(t *testing.T) {
	fixture := newFixture(t)
	_, paths := fixture.write(t)
	for _, args := range [][]string{
		{"--stream"}, {"--stream", "--keys", paths["keys"], "extra"},
		{"--stream", "--keys", paths["keys"], "--request", paths["request"]},
	} {
		if err := runWithInput(args, strings.NewReader(""), io.Discard); err == nil {
			t.Fatal("invalid mixed-mode arguments accepted")
		}
	}
	args := []string{"--stream", "--keys", paths["keys"]}
	if err := runWithInput(args, failingReader{}, io.Discard); err == nil || !strings.Contains(err.Error(), "input unavailable") {
		t.Fatal("input failure swallowed", err)
	}
	line := bytes.TrimSuffix(jsonLine(t, fixture.envelope()), []byte{'\n'})
	if err := runWithInput(args, bytes.NewReader(line), failingWriter{}); err == nil || !strings.Contains(err.Error(), "output unavailable") {
		t.Fatal("output failure swallowed", err)
	}
	var output bytes.Buffer
	if err := runWithInput(args, bytes.NewReader(line), &output); err != nil || len(readResponses(t, output.Bytes())) != 1 {
		t.Fatal("complete final document without newline rejected", err)
	}
}

// This measures repeated in-process CLI operations, including file reads and
// JSON/signature work. It excludes process startup and OS provider execution.
func BenchmarkEvidenceFileVersusPersistentStream(b *testing.B) {
	fixture := newFixture(b)
	args, paths := fixture.write(b)
	line := jsonLine(b, fixture.envelope())
	const receiptsPerBatch = 32
	batch := bytes.Repeat(line, receiptsPerBatch)
	b.Run("per_file_32_receipts", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			for range receiptsPerBatch {
				if err := runWithInput(args, nil, io.Discard); err != nil {
					b.Fatal(err)
				}
			}
		}
		b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*receiptsPerBatch), "ns/receipt")
	})
	b.Run("persistent_32_receipts", func(b *testing.B) {
		verifier, err := loadVerifier(paths["keys"])
		if err != nil {
			b.Fatal(err)
		}
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if err := runStream(bytes.NewReader(batch), io.Discard, verifier); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*receiptsPerBatch), "ns/receipt")
	})
}
