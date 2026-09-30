package componentspec

import (
	"encoding/json"
	goparser "go/parser"
	gotoken "go/token"
	"strings"
	"testing"
)

const validSpec = `
model IMC1B {
    architecture "ilaria-microcortex-v1";
    weights ternary;
    storage tritpack20;
    compute rgba32;
}

expert GoConcurrency : IMC1B {
    specialty code.go.concurrency;
    benchmark "go-race-v1";
}

dataset GoPermissiveV3 {
    require provenance;
    require commercial_compatible;
    forbid secrets;
    forbid benchmark_leak;
}

train GoConcurrency on GoPermissiveV3 {
    cohort 512;
    optimizer isx;
    local_steps 128;
}

component Hippocampus {
    capability memory.read;
    capability memory.write;
    state episodes: EpisodicStore;
    invariant "personal memory never enters global training";
}

effect WriteFile {
    capability file.write;
    requires "path is capability-scoped";
    ensures "result contains verifier evidence";
}

verify GoFix {
    check compile;
    check test;
    check lsp.zero_errors;
}

record CorticalPacket {
    field task_id: string;
    field evidence_refs: string_list;
    field budget: u64;
}
`

func TestParseValidPlatformSpec(t *testing.T) {
	m, err := Parse("platform.swyp", validSpec)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Declarations) != 8 {
		t.Fatalf("declarations=%d want 8", len(m.Declarations))
	}
	if m.Declarations[1].Base != "IMC1B" {
		t.Fatalf("expert base=%q", m.Declarations[1].Base)
	}
	if m.Declarations[3].Dataset != "GoPermissiveV3" {
		t.Fatalf("train dataset=%q", m.Declarations[3].Dataset)
	}
}

func TestGoSourceFromRecords(t *testing.T) {
	m, err := Parse("records.swyp", `
record ExpertGenome {
  field expert_id: string;
  field genesis_seed: u64;
  field tags: string_list;
  field metadata: string_map;
  field signed: bool;
}
`)
	if err != nil {
		t.Fatal(err)
	}
	source, err := m.GoSource("myriad")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := goparser.ParseFile(gotoken.NewFileSet(), "types_gen.go", source, goparser.AllErrors); err != nil {
		t.Fatalf("generated Go does not parse: %v\n%s", err, source)
	}
	text := string(source)
	for _, want := range []string{
		"type ExpertGenome struct",
		"ExpertID",
		"`json:\"expert_id\"`",
		"GenesisSeed",
		"`json:\"genesis_seed\"`",
		"Tags",
		"[]string",
		"`json:\"tags\"`",
		"Metadata",
		"map[string]string",
		"`json:\"metadata\"`",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated Go missing %q:\n%s", want, text)
		}
	}
}

func TestRejectUnsupportedRecordType(t *testing.T) {
	_, err := Parse("bad.swyp", `record X { field value: magic; }`)
	if err == nil || !strings.Contains(err.Error(), "unsupported type") {
		t.Fatalf("err=%v", err)
	}
}

func TestCanonicalJSONRoundTrip(t *testing.T) {
	m, err := Parse("platform.swyp", validSpec)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	var got Manifest
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if err := got.Validate(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "\"kind\": \"model\"") {
		t.Fatalf("canonical JSON missing model declaration: %s", b)
	}
}

func TestRejectUnknownExpertBase(t *testing.T) {
	_, err := Parse("bad.swyp", `
expert X : Missing {
  specialty code.go;
}
`)
	if err == nil || !strings.Contains(err.Error(), "unknown base model") {
		t.Fatalf("err=%v", err)
	}
}

func TestRejectInvalidTrain(t *testing.T) {
	_, err := Parse("bad.swyp", `
model M {
  architecture a;
  weights ternary;
  storage tritpack20;
  compute rgba32;
}
expert E : M { specialty code.go; }
dataset D { require provenance; }
train E on D { cohort 0; optimizer isx; local_steps 10; }
`)
	if err == nil || !strings.Contains(err.Error(), "cohort must be a positive integer") {
		t.Fatalf("err=%v", err)
	}
}

func TestRejectEffectWithoutCapability(t *testing.T) {
	_, err := Parse("bad.swyp", `effect E { ensures "done"; }`)
	if err == nil || !strings.Contains(err.Error(), "at least one capability") {
		t.Fatalf("err=%v", err)
	}
}
