package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"swyp-lang/internal/swyplang"
	"swyp-lang/internal/synthesis"
)

const contractCLISquare = `{"version":1,"entry":"square","inputs":[{"name":"x","type":"i64","min":"-100","max":"100"}],"ensures":[{"op":"eq","args":[{"var":"result"},{"op":"mul","args":[{"var":"x"},{"var":"x"}]}]}],"max_steps":100}`
const contractCLISpec = `{"version":1,"examples":[{"x":"0","y":"0"},{"x":"1","y":"1"}]}`

func contractCLIFiles(t *testing.T) (string, string, string) {
	t.Helper()
	dir := t.TempDir()
	contract, spec, output := filepath.Join(dir, "contract.json"), filepath.Join(dir, "spec.json"), filepath.Join(dir, "generated.swyp")
	for path, data := range map[string]string{contract: contractCLISquare, spec: contractCLISpec} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return contract, spec, output
}

func TestContractSynthFailureNeverCreatesOutput(t *testing.T) {
	for _, name := range []string{"candidate-budget", "round-budget", "case-budget", "fuel-budget", "invalid-flags", "timeout", "duplicate", "null", "wrong-numeric-json", "trailing-json", "oversize-spec", "oversize-contract", "contract-injection"} {
		t.Run(name, func(t *testing.T) {
			contract, spec, output := contractCLIFiles(t)
			args := []string{"-contract", contract, "-o", output}
			var changePath, data string
			switch name {
			case "candidate-budget":
				changePath, data = spec, `{"version":1,"max_candidates":1}`
			case "round-budget":
				args = append(args, "-rounds", "1")
			case "case-budget":
				args = append(args, "-total-cases", "1")
			case "fuel-budget":
				args = append(args, "-total-steps", "1")
			case "invalid-flags":
				args = append(args, "-cases", "10001")
			case "timeout":
				args = append(args, "-timeout", "1ns")
			case "duplicate":
				changePath, data = spec, `{"version":1,"Version":1}`
			case "null":
				changePath, data = spec, `{"version":1,"examples":null}`
			case "wrong-numeric-json":
				changePath, data = spec, `{"version":1,"examples":[{"x":9007199254740993,"y":1}]}`
			case "trailing-json":
				changePath, data = spec, contractCLISpec+` {}`
			case "oversize-spec":
				changePath, data = spec, strings.Repeat(" ", 65537)
			case "oversize-contract":
				changePath, data = contract, strings.Repeat(" ", 65537)
			case "contract-injection":
				changePath, data = contract, strings.Replace(contractCLISquare, `"square"`, `"square() {} fn injected"`, 1)
			}
			if changePath != "" {
				if err := os.WriteFile(changePath, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			args = append(args, spec)
			if err := synthCommand(args); err == nil {
				t.Fatal("accepted failing scenario")
			}
			if _, err := os.Lstat(output); !os.IsNotExist(err) {
				t.Fatalf("output exists or failed to stat: %v", err)
			}
		})
	}
	_, spec, output := contractCLIFiles(t)
	for _, flag := range []string{"-allow-sampled", "-cases=10", "-contract="} {
		if err := synthCommand([]string{"-o", output, flag, spec}); err == nil {
			t.Fatalf("%s accepted without contract", flag)
		}
	}
}

func TestContractSynthReportProvenance(t *testing.T) {
	contract, spec, output := contractCLIFiles(t)
	flags := contractSynthFlags{path: contract, options: synthesis.DefaultContractOptions()}
	var buf bytes.Buffer
	if err := synthContractCommand(output, spec, time.Second, flags, &buf); err != nil {
		t.Fatal(err)
	}
	var report struct {
		Status, Output, SourceSHA256, ContractSHA256, SpecSHA256 string
		History                                                  []struct {
			Verification struct {
				SourceSHA256 string `json:"source_sha256"`
				IRSHA256     string `json:"ir_sha256"`
			}
		}
	}
	// Field tags are explicit because JSON evidence uses snake_case.
	var data map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	for key, target := range map[string]*string{"status": &report.Status, "output": &report.Output, "source_sha256": &report.SourceSHA256, "contract_sha256": &report.ContractSHA256, "spec_sha256": &report.SpecSHA256} {
		if err := json.Unmarshal(data[key], target); err != nil {
			t.Fatal(err)
		}
	}
	if err := json.Unmarshal(data["history"], &report.History); err != nil {
		t.Fatal(err)
	}
	sourceBytes, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "exhaustive" || report.Output != output || report.SourceSHA256 != coreHash(sourceBytes) || report.ContractSHA256 != coreHash([]byte(contractCLISquare)) || report.SpecSHA256 != coreHash([]byte(contractCLISpec)) {
		t.Fatalf("bad evidence: %s", buf.String())
	}
	p, err := swyplang.ParseCore(output, string(sourceBytes))
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("square")
	if err != nil {
		t.Fatal(err)
	}
	ir, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	last := report.History[len(report.History)-1].Verification
	if last.IRSHA256 != coreHash(ir) || last.SourceSHA256 != report.SourceSHA256 {
		t.Fatal("reported IR/source not the actual published program")
	}
}

type contractBrokenWriter struct{}

func (contractBrokenWriter) Write([]byte) (int, error) {
	return 0, errors.New("injected stdout failure")
}

func TestContractSynthConcurrentPublicationAndWriterFailure(t *testing.T) {
	contract, spec, output := contractCLIFiles(t)
	flags := contractSynthFlags{path: contract, options: synthesis.DefaultContractOptions()}
	var wg sync.WaitGroup
	start, results := make(chan struct{}), make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			var buf bytes.Buffer
			results <- synthContractCommand(output, spec, time.Second, flags, &buf)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("exclusive publication successes=%d", successes)
	}
	other := filepath.Join(t.TempDir(), "valid.swyp")
	if err := synthContractCommand(other, spec, time.Second, flags, contractBrokenWriter{}); err == nil {
		t.Fatal("ignored stdout failure")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("deleted a successfully published file after stdout failure")
	}
}

func TestContractSynthExplicitSampleAcceptance(t *testing.T) {
	contract, spec, output := contractCLIFiles(t)
	if err := os.WriteFile(contract, []byte(strings.ReplaceAll(contractCLISquare, `"i64"`, `"f64"`)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := synthCommand([]string{"-contract", contract, "-o", output, spec}); err == nil {
		t.Fatal("implicitly accepted sampled evidence")
	}
	if _, err := os.Lstat(output); !os.IsNotExist(err) {
		t.Fatal("published default sampled candidate")
	}
	if err := synthCommand([]string{"-contract", contract, "-allow-sampled", "-o", output, spec}); err != nil {
		t.Fatal(err)
	}
}

func TestContractSynthRealProcessWithoutToolchain(t *testing.T) {
	contract, spec, output := contractCLIFiles(t)
	exe := filepath.Join(t.TempDir(), "swyp-contract.exe")
	build := exec.Command("go", "build", "-o", exe, ".")
	if data, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, data)
	}
	env := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "PATH=") {
			env = append(env, entry)
		}
	}
	env = append(env, "PATH="+t.TempDir())
	run := func(args ...string) []byte {
		t.Helper()
		cmd := exec.Command(exe, args...)
		cmd.Env = env
		data, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, data)
		}
		return data
	}
	result := run("synth", "-contract", contract, "-o", output, spec)
	if !bytes.Contains(result, []byte(`"status":"exhaustive"`)) {
		t.Fatalf("%s", result)
	}
	irPath := filepath.Join(t.TempDir(), "square.core.json")
	run("ir", "-entry", "square", "-o", irPath, output)
	if err := os.Remove(output); err != nil {
		t.Fatal(err)
	}
	result = run("core-exec", "-entry", "square", irPath, "12")
	if !bytes.Contains(result, []byte(`"value":"144"`)) {
		t.Fatalf("%s", result)
	}
}
