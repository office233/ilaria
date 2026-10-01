package continuation

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func testCheckpoint(t *testing.T) Checkpoint {
	t.Helper()
	state := []byte(`{"state":"exact"}`)
	stateHash, err := HashState(state)
	if err != nil {
		t.Fatal(err)
	}
	return Checkpoint{
		ProtocolVersion: Version, Type: "continuation", StateVersion: StateVersion,
		RunID: "run-1", ModuleHash: strings.Repeat("a", 64), Entry: "main",
		FuelLimit: 1000, StepsUsed: 41, MaxEffectBytes: 4096, EffectBytes: 3,
		EffectCursor: 2, EffectRequestHash: strings.Repeat("b", 64),
		EffectResultHash: strings.Repeat("c", 64), StateHash: stateHash, State: state,
	}
}

func TestCheckpointRoundTripAndHostBinding(t *testing.T) {
	checkpoint := testCheckpoint(t)
	if err := ValidateCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeCheckpoint(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded.State, checkpoint.State) || decoded.EffectCursor != checkpoint.EffectCursor {
		t.Fatalf("decoded=%+v", decoded)
	}
	binding, err := BindingBytes(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(binding, []byte(BindingDomain)) || bytes.Contains(binding, checkpoint.State) {
		t.Fatalf("unexpected binding bytes %q", binding)
	}
	hash, err := EnvelopeHash(decoded)
	if err != nil || len(hash) != 64 {
		t.Fatalf("hash=%q err=%v", hash, err)
	}
}

func TestCheckpointRejectsCorruptionLimitsAndAmbiguousWire(t *testing.T) {
	checkpoint := testCheckpoint(t)
	raw, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	stateB64 := base64.StdEncoding.EncodeToString(checkpoint.State)
	for name, data := range map[string][]byte{
		"unknown":   bytes.Replace(raw, []byte(`"state":`), []byte(`"unknown":1,"state":`), 1),
		"duplicate": bytes.Replace(raw, []byte(`"run_id":"run-1"`), []byte(`"run_id":"run-1","run_id":"run-1"`), 1),
		"alias":     bytes.Replace(raw, []byte(`"run_id"`), []byte(`"Run_ID"`), 1),
		"trailing":  append(append([]byte(nil), raw...), []byte("{}")...),
		"null":      bytes.Replace(raw, []byte(`"state":"`+stateB64+`"`), []byte(`"state":null`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeCheckpoint(data); err == nil {
				t.Fatalf("accepted %s: %s", name, data)
			}
		})
	}

	for name, mutate := range map[string]func(*Checkpoint){
		"fuel":        func(c *Checkpoint) { c.StepsUsed = c.FuelLimit + 1 },
		"bytes":       func(c *Checkpoint) { c.EffectBytes = c.MaxEffectBytes + 1 },
		"cursor":      func(c *Checkpoint) { c.EffectCursor = c.StepsUsed + 1 },
		"module":      func(c *Checkpoint) { c.ModuleHash = strings.Repeat("A", 64) },
		"state hash":  func(c *Checkpoint) { c.StateHash = strings.Repeat("0", 64) },
		"result hash": func(c *Checkpoint) { c.EffectResultHash = "bad" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := checkpoint
			mutate(&bad)
			if err := ValidateCheckpoint(bad); err == nil {
				t.Fatalf("accepted mutated checkpoint: %+v", bad)
			}
		})
	}

	oversized := checkpoint
	oversized.State = bytes.Repeat([]byte{1}, MaxStateBytes+1)
	if err := ValidateCheckpoint(oversized); err == nil {
		t.Fatal("accepted oversized state")
	}
}

func TestAckIsStrictlyCorrelated(t *testing.T) {
	checkpoint := testCheckpoint(t)
	ack := Ack{
		ProtocolVersion: Version, Type: "continuation_ack", RunID: checkpoint.RunID,
		ModuleHash: checkpoint.ModuleHash, Entry: checkpoint.Entry,
		EffectCursor: checkpoint.EffectCursor, StateHash: checkpoint.StateHash, Status: "accepted",
	}
	raw, err := json.Marshal(ack)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeAck(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAck(decoded, checkpoint); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Ack){
		"run":    func(a *Ack) { a.RunID = "other" },
		"module": func(a *Ack) { a.ModuleHash = strings.Repeat("d", 64) },
		"entry":  func(a *Ack) { a.Entry = "other" },
		"cursor": func(a *Ack) { a.EffectCursor++ },
		"state":  func(a *Ack) { a.StateHash = strings.Repeat("e", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := ack
			mutate(&bad)
			if err := ValidateAck(bad, checkpoint); err == nil {
				t.Fatalf("accepted mismatched ack: %+v", bad)
			}
		})
	}
	rejected := ack
	rejected.Status, rejected.ErrorCode = "rejected", "durability_failed"
	if err := ValidateAck(rejected, checkpoint); err != nil {
		t.Fatal(err)
	}
	rejected.ErrorCode = ""
	if err := ValidateAck(rejected, checkpoint); err == nil {
		t.Fatal("accepted rejection without error")
	}
}
