package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"swypik-os/core/effects"
	"swypik-os/core/supervisor"
)

type continuationAck struct {
	ProtocolVersion uint64 `json:"protocol_version"`
	Type            string `json:"type"`
	RunID           string `json:"run_id"`
	ModuleHash      string `json:"module_hash"`
	Entry           string `json:"entry"`
	EffectCursor    uint64 `json:"effect_cursor"`
	StateHash       string `json:"state_hash"`
	Status          string `json:"status"`
	ErrorCode       string `json:"error_code"`
}

func acceptedContinuationAck(binding supervisor.ContinuationBinding) continuationAck {
	return continuationAck{ProtocolVersion: 1, Type: "continuation_ack", RunID: binding.RunID,
		ModuleHash: binding.ModuleHash, Entry: binding.Entry, EffectCursor: binding.EffectCursor,
		StateHash: binding.StateHash, Status: "accepted"}
}

func rejectedContinuationAck(checkpoint supervisor.ContinuationEnvelope, code string) continuationAck {
	return continuationAck{ProtocolVersion: 1, Type: "continuation_ack", RunID: checkpoint.RunID,
		ModuleHash: checkpoint.ModuleHash, Entry: checkpoint.Entry, EffectCursor: checkpoint.EffectCursor,
		StateHash: checkpoint.StateHash, Status: "rejected", ErrorCode: code}
}

// DecodeStrict owns syntax, unknown/duplicate fields and canonical byte rules.
// Transport frames additionally require every non-optional struct field;
// encoding/json otherwise silently supplies a zero value for omitted counters.
func decodeFrame(raw []byte, destination any) error {
	if err := effects.DecodeStrict(raw, destination); err != nil {
		return err
	}
	t := reflect.TypeOf(destination).Elem()
	if t.Kind() != reflect.Struct {
		return fmt.Errorf("frame destination must be a struct")
	}
	return requireFields(raw, t)
}

func requireFields(raw []byte, t reflect.Type) error {
	for t.Kind() == reflect.Pointer {
		if string(raw) == "null" {
			return nil
		}
		t = t.Elem()
	}
	if t.Kind() == reflect.Slice && t.Elem().Kind() != reflect.Uint8 {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return err
		}
		for _, item := range items {
			if err := requireFields(item, t.Elem()); err != nil {
				return err
			}
		}
		return nil
	}
	if t.Kind() == reflect.Map {
		var values map[string]json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil {
			return err
		}
		for _, value := range values {
			if err := requireFields(value, t.Elem()); err != nil {
				return err
			}
		}
		return nil
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	for i := 0; i < t.NumField(); i++ {
		tag := strings.Split(t.Field(i).Tag.Get("json"), ",")
		if tag[0] == "" || tag[0] == "-" {
			continue
		}
		optional := false
		for _, option := range tag[1:] {
			optional = optional || option == "omitempty"
		}
		value, present := fields[tag[0]]
		if !optional && !present {
			return fmt.Errorf("missing required frame field %q", tag[0])
		}
		if present {
			if err := requireFields(value, t.Field(i).Type); err != nil {
				return fmt.Errorf("frame field %s: %w", tag[0], err)
			}
		}
	}
	return nil
}
