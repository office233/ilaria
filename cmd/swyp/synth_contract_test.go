package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContractSynthCommandIntegration(t *testing.T) {
	cases := []struct {
		name, contract, spec, input, want string
	}{
		{"square", `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"mul","args":[{"var":"x"},{"var":"x"}]}]}],"max_steps":100}`, `{"version":1,"examples":[{"x":"0","y":"0"},{"x":"1","y":"1"}]}`, "12", "144"},
		{"exact-i64", `{"version":1,"entry":"next","inputs":[{"name":"x","type":"i64","min":"9007199254740993","max":"9007199254741000"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"add","args":[{"var":"x"},{"const":{"type":"i64","value":"1"}}]}]}],"max_steps":100}`, `{"version":1}`, "9007199254740993", "9007199254740994"},
		{"relation-without-oracle", `{"version":1,"entry":"above","inputs":[{"name":"x","type":"i64","min":"-20","max":"20"}],"ensures":[{"op":"gt","args":[{"var":"result"},{"var":"x"}]},{"op":"le","args":[{"var":"result"},{"op":"add","args":[{"var":"x"},{"const":{"type":"i64","value":"1"}}]}]}],"max_steps":100}`, `{"version":1}`, "7", "8"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			contract, spec, output := filepath.Join(dir, "contract.json"), filepath.Join(dir, "spec.json"), filepath.Join(dir, "candidate.swyp")
			for path, data := range map[string]string{contract: tc.contract, spec: tc.spec} {
				if err := os.WriteFile(path, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := synthCommand([]string{"-contract", contract, "-o", output, spec}); err != nil {
				t.Fatal(err)
			}
			var c struct {
				Entry string `json:"entry"`
			}
			if err := json.Unmarshal([]byte(tc.contract), &c); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := coreCommand("core-run", []string{"-entry", c.Entry, output, tc.input}, &out); err != nil {
				t.Fatal(err)
			}
			var run struct {
				Result struct{ Value struct{ Type, Value string } }
			}
			if err := json.Unmarshal(out.Bytes(), &run); err != nil {
				t.Fatal(err)
			}
			if run.Result.Value.Type != "i64" || run.Result.Value.Value != tc.want {
				t.Fatalf("unexpected typed result: %s", out.String())
			}
			out.Reset()
			if err := coreCommand("verify", []string{"-contract", contract, output}, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), `"status":"exhaustive"`) {
				t.Fatalf("not exhaustive: %s", out.String())
			}
			before, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			if err := synthCommand([]string{"-contract", contract, "-o", output, spec}); err == nil {
				t.Fatal("overwrote an existing candidate")
			}
			after, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("changed an existing candidate")
			}
		})
	}
}
