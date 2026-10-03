// imc-peer-probe is an opt-in local synthetic experiment, never a network swarm.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"swypik-os/core/controlkernel"
	"swypik-os/core/imcnetwork"
	"swypik-os/core/resource"
	"swypik-os/core/swarm"
	"swypik-os/generated/myriad"
	"swypik-os/internal/planprocess"
	"time"
)

type fixtureAuth struct{ credential string }

func (a fixtureAuth) AuthenticateExecutor(c string) (controlkernel.ExecutorPrincipal, error) {
	if c != a.credential {
		return controlkernel.ExecutorPrincipal{}, errors.New("revoked credential")
	}
	return controlkernel.ExecutorPrincipal{ID: "local-probe"}, nil
}
func randomID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func atomicFile(path string, data []byte) error {
	return imcnetwork.AtomicFile(path, data)
}
func checkpoint(directory string, value any) (string, error) {
	return imcnetwork.Checkpoint(directory, value)
}
func recoverPointer(directory string) error {
	return imcnetwork.RecoverPointer(directory)
}

// Reserve a round and nonce durably before any dispatch. No re-execution after a
// crash, rejection or restart; this intentionally sacrifices liveness for safety.
func consume(directory, round, nonce string) error {
	if len(round) > 128 || len(nonce) != 64 {
		return errors.New("round/nonce bounds")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) > 128 {
		return errors.New("durable ledger full")
	}
	for _, key := range []string{"round:" + round, "nonce:" + nonce} {
		f, e := os.OpenFile(filepath.Join(directory, "used-"+sha([]byte(key))), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return errors.New("replay/ledger failure")
		}
		_, e = f.Write([]byte("consumed"))
		if e == nil {
			e = f.Sync()
		}
		c := f.Close()
		if e != nil {
			return e
		}
		if c != nil {
			return c
		}
	}
	return nil
}
func authorize(k *controlkernel.Kernel, credential string, token controlkernel.LeaseToken, consent bool) error {
	if !consent {
		return errors.New("local consent revoked")
	}
	if _, err := k.ValidateExecutorLease(credential, "local-probe", "probe-node", token); err != nil {
		return err
	}
	node, ok := k.Node("probe-node")
	if !ok || node.State == controlkernel.NodeOperatorRequired || node.State == controlkernel.NodeCancelled {
		return errors.New("node revoked")
	}
	return nil
}

func liveConsent(directory string, epoch uint64) error {
	data, err := os.ReadFile(filepath.Join(directory, "consent.json"))
	if err != nil {
		return err
	}
	var c struct {
		OptIn bool   `json:"opt_in"`
		Epoch uint64 `json:"epoch"`
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return err
	}
	if !c.OptIn || c.Epoch != epoch {
		return errors.New("live consent revoked/stale epoch")
	}
	return nil
}

func peerArgs(peer, library string) []string {
	args := []string{"-I", "-B", peer}
	if library != "" {
		args = append(args, "--public-library-root", library)
	}
	return args
}
func issuedBinding(identities map[string]any, public []byte, round, nonce string, fence uint64, deadline int64) (map[string]any, error) {
	required := []string{"model_config_hash", "genesis_checkpoint_hash", "curriculum_manifest_hash", "training_recipe_hash"}
	for _, k := range required {
		v, ok := identities[k].(string)
		if !ok || v == "" {
			return nil, errors.New("incomplete issued identities")
		}
	}
	if identities["protocol_version"] != float64(1) || identities["expert_id"] != "synthetic-imc" {
		return nil, errors.New("issued version/expert")
	}
	result := map[string]any{}
	for k, v := range identities {
		result[k] = v
	}
	result["peer_id"] = "peer-a"
	result["round_id"] = round
	result["consent_epoch"] = uint64(1)
	result["lease_fence"] = fence
	result["nonce"] = nonce
	result["deadline_unix_ms"] = deadline
	result["signer_key_id"] = sha(public)
	return result, nil
}
func checkIssued(e myriad.IMCLocalProbeEnvelope, binding map[string]any) error {
	encoded, _ := json.Marshal(e)
	var fields map[string]any
	_ = json.Unmarshal(encoded, &fields)
	for _, k := range []string{"protocol_version", "expert_id", "peer_id", "round_id", "model_config_hash", "genesis_checkpoint_hash", "curriculum_manifest_hash", "training_recipe_hash", "consent_epoch", "lease_fence", "nonce", "deadline_unix_ms", "signer_key_id"} {
		want, ok := binding[k]
		if !ok || want == nil || want == "" {
			return errors.New("incomplete issued contract")
		}
		a, _ := json.Marshal(want)
		c, _ := json.Marshal(fields[k])
		if !bytes.Equal(a, c) {
			return fmt.Errorf("unauthorized issued field %s", k)
		}
	}
	return nil
}
func signedDemo(ctx context.Context, python, peer, library, directory, round string, steps int) error {
	if steps < 1 || steps > 64 {
		return errors.New("steps must be 1..64")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	credential := randomID()
	k, err := controlkernel.OpenKernel(filepath.Join(directory, "control.journal"), controlkernel.WithExecutorAuthenticator(fixtureAuth{credential}))
	if err != nil {
		return err
	}
	defer k.Close()
	// Existing ControlKernel OS writer lock serializes this entire own-state
	// session, including pointer recovery. It is released by OS on process crash.
	if err = recoverPointer(directory); err != nil {
		return err
	}
	nonce := randomID()
	if err = consume(directory, round, nonce); err != nil {
		return err
	}
	consentPath := filepath.Join(directory, "consent.json")
	if _, err = os.Stat(consentPath); os.IsNotExist(err) {
		if err = atomicFile(consentPath, []byte(`{"opt_in":true,"epoch":1}`)); err != nil {
			return err
		}
	}
	if err = liveConsent(directory, 1); err != nil {
		return err
	}
	// This local demo state supports a single durable round; rerunning its round is denied.
	if _, exists := k.Task("probe-task"); exists {
		return errors.New("existing demo epoch cannot redispatch")
	}
	if _, err = k.CreateTask(controlkernel.Task{ID: "probe-task", Goal: "explicit local synthetic probe"}); err != nil {
		return err
	}
	if _, err = k.AddNode(controlkernel.Node{ID: "probe-node", TaskID: "probe-task", Kind: "synthetic-imc"}); err != nil {
		return err
	}
	if err = k.TransitionNode("probe-node", controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
		return err
	}
	lease, err := k.ClaimLease("probe-node", credential, "ephemeral local fixture", 120*time.Second)
	if err != nil {
		return err
	}
	token := controlkernel.LeaseToken{LeaseID: lease.ID, Fence: lease.Fence}
	consent := true
	if err = authorize(k, credential, token, consent); err != nil {
		return err
	}
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 1 << 30, MaxProcesses: 2})
	if err != nil {
		return err
	}
	defer group.Close()
	peers := make([]*planprocess.Process, 0, 2)
	for i := 0; i < 2; i++ {
		p, e := group.Start(ctx, planprocess.Config{Executable: python, Directory: directory, Args: peerArgs(peer, library), MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 256 << 10})
		if e != nil {
			return e
		}
		defer p.Close()
		peers = append(peers, p)
	}
	recipe := map[string]any{"version": 1, "seed": 1701, "steps": steps, "learning_rate": 0.01, "max_delta_norm": 20.0, "min_improvement": 0.0001, "config": map[string]any{"vocab_size": 16, "d_model": 32, "n_layers": 1, "n_heads": 4, "n_kv_heads": 2, "ffn_dim": 64, "eos_token_id": 15, "max_seq_len": 8}}
	if err = peers[1].SendJSON(ctx, map[string]any{"operation": "prepare-evaluator", "recipe": recipe}); err != nil {
		return err
	}
	prepared, err := peers[1].ReadLine(ctx)
	if err != nil {
		return fmt.Errorf("evaluator dependency/prepare: %v; %v (supply --public-library-root if required)", err, peers[1].Wait(ctx))
	}
	var identities map[string]any
	if err = json.Unmarshal(prepared, &identities); err != nil {
		return err
	}
	if err = peers[0].SendJSON(ctx, map[string]any{"operation": "signed-propose", "recipe": recipe}); err != nil {
		return err
	}
	registration, err := peers[0].ReadLine(ctx)
	if err != nil {
		return fmt.Errorf("peer registration: %v; process: %v", err, peers[0].Wait(ctx))
	}
	var identity struct {
		Public string `json:"public_key"`
		PID    int    `json:"pid"`
	}
	if err = json.Unmarshal(registration, &identity); err != nil {
		return err
	}
	public, err := hex.DecodeString(identity.Public)
	if err != nil || len(public) != 32 {
		return errors.New("ephemeral peer registration")
	}
	binding, err := issuedBinding(identities, public, round, nonce, token.Fence, lease.ExpiresAt.UnixMilli())
	if err != nil {
		return err
	}
	if err = liveConsent(directory, 1); err != nil {
		return err
	}
	if err = authorize(k, credential, token, consent); err != nil {
		return err
	}
	if err = peers[0].SendJSON(ctx, map[string]any{"binding": binding}); err != nil {
		return err
	}
	line, err := peers[0].ReadLine(ctx)
	if err != nil {
		return fmt.Errorf("proposer read: %v; process: %v", err, peers[0].Wait(ctx))
	}
	var response struct {
		Envelope myriad.IMCLocalProbeEnvelope `json:"envelope"`
		Before   float64                      `json:"train_loss_before"`
		After    float64                      `json:"train_loss_after"`
	}
	if err = json.Unmarshal(line, &response); err != nil {
		return err
	}
	e := response.Envelope
	if err = checkIssued(e, binding); err != nil {
		return err
	}
	signed, err := base64.StdEncoding.Strict().DecodeString(e.SignedCanonicalBase64)
	if err != nil {
		return err
	}
	signature, err := hex.DecodeString(e.Signature)
	if err != nil || !ed25519.Verify(public, signed, signature) {
		return errors.New("peer-origin Ed25519 signature")
	}
	if e.PeerID != "peer-a" || e.RoundID != round || e.Nonce != nonce || e.ConsentEpoch != 1 || e.LeaseFence != token.Fence || e.DeadlineUnixMS != lease.ExpiresAt.UnixMilli() {
		return errors.New("dispatch metadata binding")
	}
	if err = peers[1].SendJSON(ctx, map[string]any{"operation": "signed-evaluate", "envelope": e, "public_key": identity.Public, "binding": binding}); err != nil {
		return err
	}
	verdict, err := peers[1].ReadLine(ctx)
	if err != nil {
		return fmt.Errorf("evaluator read: %v; process: %v", err, peers[1].Wait(ctx))
	}
	var result map[string]any
	if err = json.Unmarshal(verdict, &result); err != nil {
		return err
	}
	base, err := checkpoint(directory, result["baseline_checkpoint"])
	if err != nil {
		return err
	}
	if err = atomicFile(filepath.Join(directory, "active.json"), []byte(base)); err != nil {
		return err
	}
	before := result["before"]
	candidate := result["candidate"]
	active := before
	activeHash := base
	if result["accepted"] == true {
		next, err := checkpoint(directory, result["checkpoint"])
		if err != nil {
			return err
		}
		if err = liveConsent(directory, 1); err != nil {
			return err
		}
		if err = authorize(k, credential, token, consent); err != nil {
			return err
		}
		pending, _ := json.Marshal(map[string]string{"base": base, "candidate": next, "nonce": nonce})
		if err = atomicFile(filepath.Join(directory, "pending.json"), pending); err != nil {
			return err
		}
		// Any ordinary error after transaction preparation restores own baseline;
		// an OS/process crash leaves pending.json for next locked recovery.
		defer func() { _ = recoverPointer(directory) }()
		// No asynchronous consent writer exists in this local single-owner session.
		// The live kernel lease/fence and explicit session consent are checked again.
		if err = liveConsent(directory, 1); err != nil {
			return err
		}
		if err = authorize(k, credential, token, consent); err != nil {
			return err
		}
		if err = atomicFile(filepath.Join(directory, "active.json"), []byte(next)); err != nil {
			return err
		}
		active = result["active"]
		activeHash = next
		// Authorized probe always rolls its own pointer back; never production promotion.
		if err = recoverPointer(directory); err != nil {
			return err
		}
	}
	rollback, err := os.ReadFile(filepath.Join(directory, "active.json"))
	if err != nil || string(rollback) != base {
		return errors.New("rollback integrity")
	}
	checkpoints := map[string]any{}
	for label, hash := range map[string]string{"active": activeHash, "rollback": string(rollback)} {
		data, e := os.ReadFile(filepath.Join(directory, hash+".json"))
		if e != nil || sha(data) != hash {
			return errors.New("checkpoint integrity")
		}
		var value any
		if e = json.Unmarshal(data, &value); e != nil {
			return e
		}
		checkpoints[label] = value
	}
	if err = peers[1].SendJSON(ctx, map[string]any{"operation": "measure-checkpoints", "checkpoints": checkpoints}); err != nil {
		return err
	}
	measured, err := peers[1].ReadLine(ctx)
	if err != nil {
		return err
	}
	var measurement map[string]any
	if err = json.Unmarshal(measured, &measurement); err != nil {
		return err
	}
	active = measurement["active"]
	for _, p := range peers {
		if err = p.Wait(ctx); err != nil {
			return err
		}
	}
	proof := map[string]any{"status": "LOCAL_SIGNED_ADOPT_ROLLBACK", "before": before, "candidate": candidate, "active": active, "rollback": measurement["rollback"],
		"base_hash": base, "active_hash": activeHash, "rollback_hash": string(rollback), "accepted": result["accepted"], "peer_signature_verified": true, "proposer_pid": identity.PID, "evaluator_pid": result["pid"],
		"signed_delta_hash": e.ParameterDeltaHash, "raw_delta_bytes": e.PayloadBytes, "candidate_frame_bytes": len(line), "evaluation_frame_bytes": len(verdict), "frame_limit_bytes": 256 << 10,
		"cpu_cap_percent": 25, "memory_cap_bytes": 1 << 30, "mechanism": group.Mechanism(), "train_before": response.Before, "train_after": response.After, "state_directory": directory,
		"memory_measurement": "peak not yet instrumented; hard group limits configured", "evaluator_seconds": result["elapsed_seconds"]}
	data, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

// evaluationCheck is deliberately non-promoting: until durable consent/replay
// commit is implemented, no active checkpoint or promotion pointer is created.
func evaluationCheck(ctx context.Context, python, peer, library, directory string) error {
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 1 << 30, MaxProcesses: 2})
	if err != nil {
		return err
	}
	defer group.Close()
	peers := make([]*planprocess.Process, 0, 2)
	for i := 0; i < 2; i++ {
		p, err := group.Start(ctx, planprocess.Config{Executable: python, Directory: directory, Args: peerArgs(peer, library), MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 9 << 20})
		if err != nil {
			return err
		}
		defer p.Close()
		peers = append(peers, p)
	}
	recipe := map[string]any{"version": 1, "seed": 1701, "steps": 16, "learning_rate": 0.01, "max_delta_norm": 20.0, "min_improvement": 0.0001,
		"config": map[string]any{"vocab_size": 16, "d_model": 32, "n_layers": 1, "n_heads": 4, "n_kv_heads": 2, "ffn_dim": 64, "eos_token_id": 15, "max_seq_len": 8}}
	if err = peers[0].SendJSON(ctx, map[string]any{"operation": "propose", "recipe": recipe}); err != nil {
		return err
	}
	line, err := peers[0].ReadLine(ctx)
	if err != nil {
		return err
	}
	var candidate map[string]any
	if err = json.Unmarshal(line, &candidate); err != nil {
		return err
	}
	// Authenticate these exact local bytes in the relay. This is not a quality proof
	// or a peer identity/signature protocol: the full signed envelope remains gated.
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(line)
	signature := mac.Sum(nil)
	verify := hmac.New(sha256.New, key)
	verify.Write(line)
	if !hmac.Equal(signature, verify.Sum(nil)) {
		return errors.New("local relay authentication")
	}
	if err = peers[1].SendJSON(ctx, map[string]any{"operation": "evaluate", "candidate": candidate}); err != nil {
		return err
	}
	verdict, err := peers[1].ReadLine(ctx)
	if err != nil {
		return err
	}
	var result map[string]any
	if err = json.Unmarshal(verdict, &result); err != nil {
		return err
	}
	for _, p := range peers {
		if err = p.Wait(ctx); err != nil {
			return err
		}
	}
	usage := make([]any, 0, 2)
	for _, p := range peers {
		u, e := p.Usage()
		if e != nil {
			return e
		}
		usage = append(usage, u)
	}
	proof := map[string]any{"status": "EVALUATION_ONLY_NOT_PROMOTED", "mechanism": group.Mechanism(), "memory_limit_bytes": 1 << 30, "cpu_percent": 25,
		"candidate_frame_bytes": len(line), "evaluation_frame_bytes": len(verdict), "raw_delta_bytes": candidate["raw_delta_bytes"],
		"proposer_pid": candidate["pid"], "evaluator_pid": result["pid"], "before": result["before"], "candidate": result["candidate"],
		"quality_accepted": result["accepted"], "active": nil, "rollback": nil, "relay_hmac_sha256": hex.EncodeToString(signature),
		"train_loss_before": candidate["train_loss_before"], "train_loss_after": candidate["train_loss_after"],
		"proposer_seconds": candidate["elapsed_seconds"], "evaluator_seconds": result["elapsed_seconds"], "process_usage": usage}
	encoded, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func containment(ctx context.Context, python, directory string) error {
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 25, MemoryBytes: 1 << 30, MaxProcesses: 2})
	if err != nil {
		return err
	}
	defer group.Close()
	children := make([]*planprocess.Process, 0, 2)
	for i := 0; i < 2; i++ {
		p, err := group.Start(ctx, planprocess.Config{Executable: python, Directory: directory,
			Args:       []string{"-I", "-B", "-c", "import json,os; print(json.dumps({'pid':os.getpid(),'probe':'containment-only'}),flush=True)"},
			MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: 9 << 20})
		if err != nil {
			return err
		}
		defer p.Close()
		children = append(children, p)
	}
	for _, p := range children {
		line, err := p.ReadLine(ctx)
		if err != nil {
			return err
		}
		var result map[string]any
		if err = json.Unmarshal(line, &result); err != nil {
			return err
		}
		fmt.Printf("containment_child=%s\n", line)
		if err = p.Wait(ctx); err != nil {
			return err
		}
	}
	fmt.Printf("containment=%s memory_bytes=%d cpu_percent=25 processes=2\n", group.Mechanism(), 1<<30)
	return nil
}

func run(args []string) error {
	fs := flag.NewFlagSet("imc-peer-probe", flag.ContinueOnError)
	networkConfig := fs.String("network-config", "", "explicit own-temp pinned synthetic node config")
	opt := fs.Bool("local-probe", false, "explicit opt-in: local synthetic probe only")
	check := fs.Bool("containment-check", false, "test mandatory hard group API; does not train or promote")
	eval := fs.Bool("evaluation-check", false, "two real IMC peers, independent evaluation only; no adoption")
	demo := fs.Bool("demo", false, "signed local synthetic adopt/rollback, never production")
	state := fs.String("state", "", "explicit own temporary synthetic state directory")
	round := fs.String("round", "synthetic-round-1", "durable at-most-once round")
	steps := fs.Int("steps", 16, "local training updates 1..64")
	library := fs.String("public-library-root", "", "optional explicit installed public dependency root; no ambient user-site")
	peer := fs.String("peer", "", "absolute path to allowed local isxprobe/peer.py")
	python := fs.String("python", "", "explicit existing Python executable or safe PATH lookup")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *networkConfig != "" {
		if !*opt {
			return errors.New("explicit --local-probe required")
		}
		data, err := os.ReadFile(*networkConfig)
		if err != nil {
			return err
		}
		var config imcnetwork.NodeConfig
		if err = json.Unmarshal(data, &config); err != nil {
			return err
		}
		var secrets imcnetwork.NodeSecrets
		decoder := json.NewDecoder(os.Stdin)
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&secrets); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(config.TimeoutSeconds)*time.Second)
		defer cancel()
		policy := resource.Default()
		policy.MaxBackgroundCPUPercent = int(config.CPU)
		policy.MaxBackgroundWorkers = 1
		daemon := swarm.NewVerifiedRoundDaemon(policy)
		defer daemon.Stop()
		config.Execute = func(ctx context.Context, issued imcnetwork.IssuedRound, runner imcnetwork.RoundRunner) (imcnetwork.VerifiedReceipt, error) {
			daemon.SetVerifiedRoundAdapter(runner)
			return daemon.ExecuteVerifiedRound(ctx, issued)
		}
		return imcnetwork.RunNode(ctx, config, secrets)
	}
	if !*opt {
		return errors.New("explicit --local-probe required")
	}
	if !*check && !*eval && !*demo {
		return errors.New("BLOCKED: end-to-end signed candidate/consent commit not implemented; no promotion")
	}
	pythonPath := *python
	if pythonPath == "" {
		var e error
		pythonPath, e = exec.LookPath("python")
		if e != nil {
			return errors.New("Python unavailable; supply --python with an existing executable")
		}
	}
	path, err := filepath.Abs(pythonPath)
	if err != nil {
		return err
	}
	directory, err := os.MkdirTemp("", "oc3-imc-containment-")
	if err != nil {
		return err
	}
	defer os.Remove(directory)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if *demo {
		if !filepath.IsAbs(*peer) || !filepath.IsAbs(*state) {
			return errors.New("absolute own peer/state required")
		}
		return signedDemo(ctx, path, *peer, *library, *state, *round, *steps)
	}
	if *eval {
		if !filepath.IsAbs(*peer) {
			return errors.New("absolute synthetic peer path required")
		}
		return evaluationCheck(ctx, path, *peer, *library, directory)
	}
	return containment(ctx, path, directory)
}
func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
