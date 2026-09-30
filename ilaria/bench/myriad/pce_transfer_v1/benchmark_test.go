package pce_transfer_v1

import (
	"bufio"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/pce"
	"ilaria/runtime/protocol"
)

type task struct {
	ID         string
	Domain     string
	TeachState string
	Action     string
	Result     string
	EvalPrompt string
	Expected   string
}

const ancestryHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func loadTasks(t *testing.T) []task {
	t.Helper()
	f, err := os.Open("tasks.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	seen := map[string]bool{}
	var out []task
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var raw map[string]string
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			t.Fatalf("decode benchmark task: %v", err)
		}
		item := task{
			ID:         raw["id"],
			Domain:     raw["domain"],
			TeachState: raw["teach_state"],
			Action:     raw["action"],
			Result:     raw["result"],
			EvalPrompt: raw["eval_prompt"],
			Expected:   raw["expected"],
		}
		if item.ID == "" || item.Domain == "" || item.TeachState == "" ||
			item.Action == "" || item.Result == "" || item.EvalPrompt == "" ||
			item.Expected == "" {
			t.Fatalf("incomplete task: %+v", item)
		}
		if seen[item.ID] {
			t.Fatalf("duplicate task id %q", item.ID)
		}
		seen[item.ID] = true
		out = append(out, item)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(out) < 12 {
		t.Fatalf("benchmark too small: %d tasks", len(out))
	}
	return out
}

func TestFrozenTasksCompileToVerifiedReplayExamples(t *testing.T) {
	tasks := loadTasks(t)
	seed := sha256.Sum256([]byte("ilaria-pce-transfer-v1-test-key"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	publicKey := privateKey.Public().(ed25519.PublicKey)

	for _, item := range tasks {
		t.Run(item.ID, func(t *testing.T) {
			event := myriad.WorldEvent{
				ProtocolVersion: protocol.Version,
				EventID:         "event-" + item.ID,
				DeviceClass:     "synthetic-benchmark",
				SourceNamespace: "pce-transfer-v1",
				ObservationType: "verified-skill",
				Features:        map[string]string{"state": item.TeachState},
				Action:          item.Action,
				Result:          item.Result,
				Verifier:        "pce-transfer-v1-verifier",
				ConfidencePPM:   protocol.MaxPPM,
				PrivacyClass:    string(protocol.PrivacyCurated),
			}
			capsule, err := pce.NewFromWorldEvent(event, pce.Options{
				CapsuleID:            "capsule-" + item.ID,
				SourceCellID:         "cell-a",
				SourceExpertID:       "DeviceCortex",
				AncestryHash:         ancestryHash,
				Domain:               item.Domain,
				ObservationSchema:    "world-event-v1",
				AbstractState:        item.TeachState,
				ActionOrHypothesis:   item.Action,
				RewardPPM:            protocol.MaxPPM,
				VerifierEvidenceHash: ancestryHash,
				ProvenanceRefs:       []string{"bench:pce-transfer-v1:" + item.ID},
				ReplayRecipe:         pce.ReplayRecipeSupervisedV1,
				CreatedUnixMS:        1_800_000_000_000,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := pce.Sign(&capsule, "bench-key-v1", privateKey); err != nil {
				t.Fatal(err)
			}
			replay, err := pce.ToReplayExample(capsule, publicKey, ancestryHash)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(replay.Prompt, item.TeachState) {
				t.Fatalf("replay prompt lost teach state: %q", replay.Prompt)
			}
			if !strings.Contains(strings.ToLower(replay.Target), strings.ToLower(item.Expected)) {
				t.Fatalf("target %q does not contain expected %q", replay.Target, item.Expected)
			}
		})
	}
}
