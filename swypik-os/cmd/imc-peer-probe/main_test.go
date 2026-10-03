package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"swypik-os/core/controlkernel"
	"swypik-os/generated/myriad"
	"swypik-os/internal/planprocess"
	"testing"
	"time"
)

func TestOptInAndNoPromotionFallback(t *testing.T) {
	if run(nil) == nil {
		t.Fatal("missing opt-in accepted")
	}
	if run([]string{"--local-probe"}) == nil {
		t.Fatal("incomplete protocol allowed promotion")
	}
}

func TestReviewIssuedContractValidResignAndPortableArgs(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	identities := map[string]any{"protocol_version": float64(1), "expert_id": "synthetic-imc", "model_config_hash": "config", "genesis_checkpoint_hash": "base", "curriculum_manifest_hash": "fixture", "training_recipe_hash": "issued-recipe"}
	binding, err := issuedBinding(identities, public, "round", randomID(), 1, time.Now().Add(time.Minute).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	e := myriad.IMCLocalProbeEnvelope{ProtocolVersion: 1, ExpertID: "synthetic-imc", PeerID: "peer-a", RoundID: "round", ModelConfigHash: "config", GenesisCheckpointHash: "base", CurriculumManifestHash: "fixture", TrainingRecipeHash: "issued-recipe", ConsentEpoch: 1, LeaseFence: 1, Nonce: binding["nonce"].(string), DeadlineUnixMS: binding["deadline_unix_ms"].(int64), SignerKeyID: sha(public)}
	if err = checkIssued(e, binding); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(t.TempDir(), "active.json")
	if err = os.WriteFile(active, []byte("prior-active"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"protocol_version", "expert_id", "peer_id", "round_id", "model_config_hash", "genesis_checkpoint_hash", "curriculum_manifest_hash", "training_recipe_hash", "consent_epoch", "lease_fence", "nonce", "deadline_unix_ms", "signer_key_id"} {
		data, _ := json.Marshal(e)
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		if n, ok := m[field].(float64); ok {
			m[field] = n + 1
		} else {
			m[field] = "validly-resigned-changed"
		}
		unsigned, _ := json.Marshal(m)
		m["signed_canonical_base64"] = base64.StdEncoding.EncodeToString(unsigned)
		m["signature"] = hex.EncodeToString(ed25519.Sign(private, unsigned))
		encoded, _ := json.Marshal(m)
		var bad myriad.IMCLocalProbeEnvelope
		_ = json.Unmarshal(encoded, &bad)
		if !ed25519.Verify(public, unsigned, mustHex(bad.Signature)) {
			t.Fatal("test must use valid resign")
		}
		if checkIssued(bad, binding) == nil {
			t.Fatalf("valid re-sign accepted field %s", field)
		}
		incomplete := map[string]any{}
		for k, v := range binding {
			if k != field {
				incomplete[k] = v
			}
		}
		if checkIssued(e, incomplete) == nil {
			t.Fatal("incomplete contract accepted")
		}
	}
	after, _ := os.ReadFile(active)
	if string(after) != "prior-active" {
		t.Fatal("active mutated")
	}
	if !reflect.DeepEqual(peerArgs("peer with spaces.py", ""), []string{"-I", "-B", "peer with spaces.py"}) {
		t.Fatal("default injected user-site")
	}
	if !reflect.DeepEqual(peerArgs("peer.py", "C:\\public libraries\\site-packages"), []string{"-I", "-B", "peer.py", "--public-library-root", "C:\\public libraries\\site-packages"}) {
		t.Fatal("library path split/hardcoded")
	}
}
func mustHex(s string) []byte { b, _ := hex.DecodeString(s); return b }

func TestLiveConsentKernelRevokeFence(t *testing.T) {
	dir := t.TempDir()
	if err := atomicFile(filepath.Join(dir, "consent.json"), []byte(`{"opt_in":true,"epoch":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := liveConsent(dir, 1); err != nil {
		t.Fatal(err)
	}
	if err := atomicFile(filepath.Join(dir, "consent.json"), []byte(`{"opt_in":false,"epoch":2}`)); err != nil {
		t.Fatal(err)
	}
	if liveConsent(dir, 1) == nil {
		t.Fatal("revoked consent accepted")
	}
	credential := "public-test-only"
	k, err := controlkernel.OpenKernel(filepath.Join(dir, "control.journal"), controlkernel.WithExecutorAuthenticator(fixtureAuth{credential}))
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	if _, err = k.CreateTask(controlkernel.Task{ID: "task", Goal: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	if _, err = k.AddNode(controlkernel.Node{ID: "probe-node", TaskID: "task", Kind: "test"}); err != nil {
		t.Fatal(err)
	}
	if err = k.TransitionNode("probe-node", controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		t.Fatal(err)
	}
	lease, err := k.ClaimLease("probe-node", credential, "local", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	if err = authorize(k, credential, token, true); err != nil {
		t.Fatal(err)
	}
	stale := token
	stale.Fence++
	if authorize(k, credential, stale, true) == nil {
		t.Fatal("stale fence")
	}
	if err = k.TransitionNode("probe-node", controlkernel.NodePreparing, token); err != nil {
		t.Fatal(err)
	}
	if err = k.TransitionNode("probe-node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	if err = k.TransitionNode("probe-node", controlkernel.NodeCancelled, token); err != nil {
		t.Fatal(err)
	}
	if authorize(k, credential, token, true) == nil {
		t.Fatal("revoked node")
	}
}

func TestStrictGroupTimeoutAndOversize(t *testing.T) {
	python := `C:\Python312\python.exe`
	if _, err := os.Stat(python); err != nil {
		t.Skip("Windows Python unavailable; no cooperative fallback")
	}
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 1 << 30, MaxProcesses: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer group.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	p, err := group.Start(ctx, planprocess.Config{Executable: python, Args: []string{"-I", "-B", "-c", "import time;time.sleep(10)"}, MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.ReadLine(ctx); err == nil {
		t.Fatal("timeout did not enforce")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	q, err := group.Start(ctx2, planprocess.Config{Executable: python, Args: []string{"-I", "-B", "-c", "print('x'*2048,flush=True)"}, MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if _, err = q.ReadLine(ctx2); !errors.Is(err, planprocess.ErrLineLimit) {
		t.Fatalf("oversize err=%v", err)
	}
}

func TestBoundedBackpressureAndProcessCap(t *testing.T) {
	python := `C:\Python312\python.exe`
	if _, err := os.Stat(python); err != nil {
		t.Skip("Windows Python unavailable")
	}
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 1 << 30, MaxProcesses: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer group.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	config := planprocess.Config{Executable: python, Args: []string{"-I", "-B", "-c", "import time;time.sleep(5)"}, MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 256 << 10}
	p, err := group.Start(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if q, err := group.Start(ctx, config); err == nil {
		q.Close()
		t.Fatal("aggregate process cap not enforced")
	}
	short, stop := context.WithTimeout(ctx, 150*time.Millisecond)
	defer stop()
	// Python deliberately does not read stdin. The bounded pipe must stop send
	// rather than accumulate an unbounded application queue.
	if err = p.SendJSON(short, map[string]string{"data": string(make([]byte, 20000))}); err == nil {
		if err = p.SendJSON(short, map[string]string{"data": string(make([]byte, 20000))}); err == nil {
			t.Fatal("backpressure did not stop blocked sends")
		}
	}
}

func TestActualProcessCrashPointerRecovery(t *testing.T) {
	if os.Getenv("OC3_SYNTHETIC_CRASH_HELPER") == "1" {
		dir := os.Getenv("OC3_SYNTHETIC_CRASH_DIRECTORY")
		base, _ := checkpoint(dir, map[string]any{"base": true})
		next, _ := checkpoint(dir, map[string]any{"candidate": true})
		if err := atomicFile(filepath.Join(dir, "pending.json"), []byte(`{"base":"`+base+`"}`)); err != nil {
			os.Exit(24)
		}
		if err := atomicFile(filepath.Join(dir, "active.json"), []byte(next)); err != nil {
			os.Exit(25)
		}
		os.Exit(23) // Abrupt process death; no defer/cleanup/recovery.
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestActualProcessCrashPointerRecovery$")
	cmd.Env = append(os.Environ(), "OC3_SYNTHETIC_CRASH_HELPER=1", "OC3_SYNTHETIC_CRASH_DIRECTORY="+dir)
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 {
		t.Fatalf("crash exit: %v", err)
	}
	if err = recoverPointer(dir); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(filepath.Join(dir, "active.json"))
	if err != nil {
		t.Fatal(err)
	}
	base, err := checkpoint(dir, map[string]any{"base": true})
	if err != nil || string(active) != base {
		t.Fatal("restart did not restore baseline")
	}
}

func TestWindowsJobMemoryCapRejectsAllocation(t *testing.T) {
	python := `C:\Python312\python.exe`
	if _, err := os.Stat(python); err != nil {
		t.Skip("Windows Python unavailable")
	}
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 64 << 20, MaxProcesses: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer group.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := group.Start(ctx, planprocess.Config{Executable: python, Args: []string{"-I", "-B", "-c", "import sys\ntry:\n x=bytearray(128*1024*1024)\nexcept MemoryError:\n print('allocation_denied',flush=True);sys.exit(23)\nprint('unexpected_success',flush=True)"}, MaxThreads: 1, MemoryLimitBytes: 64 << 20, GCPercent: 100, JSONLMaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	line, readErr := p.ReadLine(ctx)
	if readErr == nil && string(line) == "unexpected_success" {
		t.Fatal("hard memory cap bypass")
	}
	if err = p.Wait(ctx); err == nil {
		t.Fatal("allocation unexpectedly succeeded")
	}
}

func TestReplayLedgerRestartAndAtomicCrashRollback(t *testing.T) {
	dir := t.TempDir()
	nonce := randomID()
	if err := consume(dir, "round1", nonce); err != nil {
		t.Fatal(err)
	}
	if consume(dir, "round1", randomID()) == nil {
		t.Fatal("round replay accepted after reopen")
	}
	if consume(dir, "round2", nonce) == nil {
		t.Fatal("nonce replay accepted")
	}
	base, err := checkpoint(dir, map[string]any{"synthetic": 1})
	if err != nil {
		t.Fatal(err)
	}
	next, err := checkpoint(dir, map[string]any{"synthetic": 2})
	if err != nil {
		t.Fatal(err)
	}
	if err = atomicFile(filepath.Join(dir, "active.json"), []byte(next)); err != nil {
		t.Fatal(err)
	}
	if err = atomicFile(filepath.Join(dir, "pending.json"), []byte(`{"base":"`+base+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err = recoverPointer(dir); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(filepath.Join(dir, "active.json"))
	if err != nil || string(active) != base {
		t.Fatal("crash rollback", err)
	}
	if err = recoverPointer(dir); err != nil {
		t.Fatal("idempotent recovery", err)
	}
}
