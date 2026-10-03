package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func TestBoundedTextKeepsValidUTF8WithinLimit(t *testing.T) {
	long := strings.Repeat("ș", 2000) // 2 bytes per rune; cut lands mid-rune
	got := boundedText("x"+long, 2048)
	if len(got) > 2048 || !utf8.ValidString(got) {
		t.Fatalf("len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	// A JSON round trip must not grow the value past the persisted limit.
	raw, _ := json.Marshal(got)
	var back string
	_ = json.Unmarshal(raw, &back)
	if len(back) > 2048 {
		t.Fatalf("round trip grew to %d bytes", len(back))
	}
	if boundedText("a\xffb", 10) != "a�b" {
		t.Fatal("invalid bytes must be replaced before measuring")
	}
}

// jsonCheckpoint serializes like the disk store, exposing encoding growth.
type jsonCheckpoint struct{ raw []byte }

func (s *jsonCheckpoint) Load() (*Run, error) {
	if s.raw == nil {
		return nil, nil
	}
	var r Run
	if err := json.Unmarshal(s.raw, &r); err != nil {
		return nil, err
	}
	return &r, nil
}
func (s *jsonCheckpoint) Save(r Run) error {
	raw, err := json.Marshal(r)
	s.raw = raw
	return err
}

// A long non-ASCII model error used to be cut mid-rune, grow on persistence and
// make every later start fail with "saved run exceeds limits".
func TestLongNonASCIIErrorSurvivesRestart(t *testing.T) {
	store := &jsonCheckpoint{}
	var calls atomic.Int32
	failing := plannerFunc(func(context.Context, string, []Spec, []Observation) (Decision, error) {
		return Decision{}, errors.New("x" + strings.Repeat("ă", 3000))
	})
	m, err := NewPersistent(failing, recoveryTools(&calls), Limits{}, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("inspect"); err != nil {
		t.Fatal(err)
	}
	waitRun(t, m, "failed")
	m.Close()
	if _, err := NewPersistent(failing, recoveryTools(&calls), Limits{}, store); err != nil {
		t.Fatalf("restart after long error: %v", err)
	}
}

type quarantineStore struct {
	memoryCheckpoint
	loadErr     error
	quarantined int
}

func (s *quarantineStore) Load() (*Run, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	return s.memoryCheckpoint.Load()
}
func (s *quarantineStore) Quarantine() (string, error) {
	s.quarantined++
	s.loadErr = nil
	return "invalid-run-test.json", nil
}

func TestInvalidCheckpointIsQuarantinedNotFatal(t *testing.T) {
	var calls atomic.Int32
	store := &quarantineStore{loadErr: ErrInvalidCheckpoint}
	m, err := NewPersistent(recoveryPlanner(&calls, false), recoveryTools(&calls), Limits{}, store)
	if err != nil || store.quarantined != 1 || m.Snapshot() != nil {
		t.Fatalf("err=%v quarantined=%d", err, store.quarantined)
	}
	// Other load failures (permissions, I/O) remain fatal and are not hidden.
	store = &quarantineStore{loadErr: errors.New("permission denied")}
	if _, err := NewPersistent(recoveryPlanner(&calls, false), recoveryTools(&calls), Limits{}, store); err == nil || store.quarantined != 0 {
		t.Fatalf("I/O error must stay fatal: err=%v", err)
	}
}

func TestMissingArgumentsDefaultToEmptyObject(t *testing.T) {
	var calls atomic.Int32
	planner := plannerFunc(func(_ context.Context, _ string, _ []Spec, o []Observation) (Decision, error) {
		if len(o) == 0 {
			return Decision{Action: "tool", Tool: "test.read"}, nil
		}
		return Decision{Action: "finish", Summary: "done"}, nil
	})
	m, err := New(planner, recoveryTools(&calls), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("inspect"); err != nil {
		t.Fatal(err)
	}
	r := waitRun(t, m, "awaiting_approval")
	if string(r.Approval.Arguments) != "{}" {
		t.Fatalf("arguments=%s", r.Approval.Arguments)
	}
}

func TestPlannerAcceptsFencedJSONAndRepairsOnce(t *testing.T) {
	replies := []string{"```json\n{\"action\":\"finish\",\"summary\":\"ok\"}\n```"}
	p := JSONPlanner{Complete: func(context.Context, string) (string, error) {
		r := replies[0]
		replies = replies[1:]
		return r, nil
	}}
	d, err := p.Next(context.Background(), "g", nil, nil)
	if err != nil || d.Summary != "ok" {
		t.Fatalf("fenced: %v %+v", err, d)
	}
	var prompts []string
	replies = []string{"Sure! here you go", `{"action":"finish","summary":"fixed"}`}
	p.Complete = func(_ context.Context, prompt string) (string, error) {
		prompts = append(prompts, prompt)
		r := replies[0]
		replies = replies[1:]
		return r, nil
	}
	d, err = p.Next(context.Background(), "g", nil, nil)
	if err != nil || d.Summary != "fixed" || len(prompts) != 2 || !strings.Contains(prompts[1], "rejected") {
		t.Fatalf("repair: %v %+v %d", err, d, len(prompts))
	}
	replies = []string{"nope", "still nope"}
	if _, err := p.Next(context.Background(), "g", nil, nil); err == nil {
		t.Fatal("two invalid replies must fail closed")
	}
}

func TestDuplicateKeyCaseFoldingRejected(t *testing.T) {
	var target struct {
		Command string `json:"command"`
	}
	mixedCase := []byte(`{"command":"go test ./...","COMMAND":"del /q x"}`)
	if err := DecodeObject(mixedCase, &target, 4096); err == nil {
		t.Fatalf("expected duplicate key error for mixed-case payload, got nil (target=%+v)", target)
	}

	var nested struct {
		Action string `json:"action"`
		Args   struct {
			Path string `json:"path"`
		} `json:"args"`
	}
	nestedPayload := []byte(`{"action":"tool","args":{"path":"foo","PATH":"bar"}}`)
	if err := DecodeObject(nestedPayload, &nested, 4096); err == nil {
		t.Fatalf("expected duplicate key error for nested mixed-case payload, got nil")
	}

	validPayload := []byte(`{"command":"go test ./..."}`)
	if err := DecodeObject(validPayload, &target, 4096); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
	if target.Command != "go test ./..." {
		t.Fatalf("unexpected command decoded: %s", target.Command)
	}
}

func TestDuplicateKeyUnicodeFoldingMatchesEncodingJSON(t *testing.T) {
	type args struct {
		ExpectedSHA256 string `json:"expected_sha256"`
	}
	// U+017F (long s) folds to "S" in encoding/json, so this key sets the field.
	var probe args
	if err := json.Unmarshal([]byte(`{"expected_ſha256":"x"}`), &probe); err != nil || probe.ExpectedSHA256 != "x" {
		t.Skipf("encoding/json no longer folds U+017F (got %+v, %v)", probe, err)
	}
	var target args
	payload := []byte(`{"expected_sha256":"a","expected_ſha256":"b"}`)
	if err := DecodeObject(payload, &target, 4096); err == nil {
		t.Fatalf("keys that decode into the same field must be rejected as duplicates (target=%+v)", target)
	}
}
