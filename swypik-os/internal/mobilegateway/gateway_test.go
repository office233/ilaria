package mobilegateway

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"swypik-os/generated/myriad"
	"swypik-os/internal/planprocess"
)

func TestActualMobileTypeScriptClientToHTTPSCanonicalIMC(t *testing.T) {
	appRoot := os.Getenv("NEXUS_MOBILE_APP_ROOT")
	if appRoot == "" {
		t.Skip("set explicit public mobile worktree root for real cross-repository integration")
	}
	if runtime.GOOS != "windows" && os.Getenv("NEXUS_TEST_CGROUP_ROOT") == "" {
		t.Skip("strict process group requires supported host/delegated cgroup")
	}
	node, e := exec.LookPath("node")
	if e != nil {
		t.Fatal(e)
	}
	python, e := exec.LookPath("python")
	if e != nil {
		t.Fatal(e)
	}
	python, _ = filepath.Abs(python)
	script, _ := filepath.Abs(filepath.Join("..", "..", "..", "ilaria", "runtime", "mobileprovider", "provider.py"))
	starts := make(chan struct{}, 4)
	provider := ProcessProvider{Process: planprocess.Config{Executable: python, Args: []string{"-B", "-I", script, "--canary"}, MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: MaxBytes},
		Limits: planprocess.Limits{CPUPercent: 50, MemoryBytes: 1 << 30, MaxProcesses: 1, LinuxDelegatedRoot: os.Getenv("NEXUS_TEST_CGROUP_ROOT")}, CPULimit: 30 * time.Second, started: starts}
	mux := http.NewServeMux()
	mux.HandleFunc("/integration/worker-started", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, len(starts) >= 2) })
	mux.HandleFunc("/api/auth/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method", 405)
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "access_token": strings.Repeat("a", 64), "expires_at": "2030-01-01T00:00:00Z"})
	})
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			http.Error(w, "unauthorized", 401)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "user": map[string]any{"userId": "fixture-user", "role": "shopper", "email": nil, "displayName": nil}})
	})
	s := httptest.NewTLSServer(mux)
	defer s.Close()
	auth, e := NewBackendAuthenticator(s.URL, s.Client())
	if e != nil {
		t.Fatal(e)
	}
	g, e := New(Config{Authenticator: auth, Provider: provider, MaxConcurrent: 1, MaxRecords: 16, CancelWait: 2 * time.Second, AllowCanary: true})
	if e != nil {
		t.Fatal(e)
	}
	mux.Handle("/api/ilaria/", g)
	defer g.Close(context.Background())
	publicCA := filepath.Join(t.TempDir(), "synthetic-public-ca.pem")
	if e = os.WriteFile(publicCA, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	uriPath := filepath.ToSlash(appRoot) + "/"
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	appURI := (&url.URL{Scheme: "file", Path: uriPath}).String()
	code := `
 import assert from 'node:assert/strict';
 const origin=process.argv[1], root=process.argv[2];
 const {AuthController,createAuthApi,resolveAuthConfig}=await import(new URL('src/lib/auth-core.ts',root));
 const {IlariaClient}=await import(new URL('src/lib/ilaria-api.ts',root));
 const controller=new AuthController(createAuthApi(resolveAuthConfig('1',origin,'android')),
   {async read(){return null},async write(){}},true);
 await controller.signIn('fixture@example.test','synthetic-password');
 assert.equal(controller.getState().status,'authenticated');
 const client=new IlariaClient(controller,()=>{});
 client.setForeground(true);client.setRemoteConsent(true);
 await client.start('public synthetic canonical model request');
 const state=client.getState();
 assert.equal(state.status,'succeeded');
 assert.ok(state.response.compute_cost>0);
 assert.equal(state.response.runtime_metrics.canary,'true');
 assert.equal(state.response.runtime_metrics.training,'unavailable');
 console.log('APP_HTTPS_IMC '+JSON.stringify({forwards:state.response.compute_cost,
  model:state.response.runtime_metrics.model_hash,
  worker_cpu_ns:state.response.runtime_metrics.worker_cpu_ns,
  worker_peak_rss_bytes:state.response.runtime_metrics.worker_peak_rss_bytes,
  gateway_process_cpu_delta_ns:state.response.runtime_metrics.gateway_process_cpu_delta_ns,
  gateway_process_peak_rss_bytes:state.response.runtime_metrics.gateway_process_peak_rss_bytes,
  energy:'unmeasured'}));
 const pending=client.start('public synthetic cancellation request');
 const deadline=Date.now()+5000;
 while(!(await (await fetch(origin+'/integration/worker-started')).json())) {
  if(Date.now()>deadline)throw new Error('native worker did not actually start');
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 client.setForeground(false);await client.cancel();await pending;
 assert.equal(client.getState().status,'parked');
 assert.match(client.getState().message,/Executorul a confirmat oprirea/);
 console.log('APP_NATIVE_CANCEL worker_started=true receipt=verified_stopped late_result=discarded');
 client.close();
 `
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "--input-type=module", "-e", code, s.URL, appURI)
	cmd.Env = []string{"NODE_EXTRA_CA_CERTS=" + publicCA, "NODE_NO_WARNINGS=1", "SystemRoot=" + os.Getenv("SystemRoot")}
	cmd.Dir = t.TempDir()
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("actual TS/HTTPS/IMC gate: %v; %s", e, output)
	}
	if !bytes.Contains(output, []byte("APP_HTTPS_IMC")) {
		t.Fatal("missing actual client proof")
	}
	t.Log(strings.TrimSpace(string(output)))
}
func TestCleanupFailureNeverAcknowledgesStopped(t *testing.T) {
	started := make(chan struct{})
	var calls atomic.Int32
	g := configured(t, providerFunc(func(ctx context.Context, request myriad.CorticalRequest) (myriad.CorticalResponse, error) {
		calls.Add(1)
		if request.TaskID != "test.1" {
			return myriad.CorticalResponse{}, ErrAdmission
		}
		close(started)
		<-ctx.Done()
		return myriad.CorticalResponse{}, ErrCleanup
	}))
	s := httptest.NewTLSServer(g)
	defer s.Close()
	r := fixture()
	token := strings.Repeat("a", 64)
	done := make(chan struct{})
	go func() { defer close(done); post(t, s, "/api/ilaria/infer", r, token) }()
	<-started
	status, body := post(t, s, "/api/ilaria/cancel", r, token)
	var response myriad.CorticalResponse
	_ = DecodeCanonical(body, &response)
	if status != 200 || response.RuntimeMetrics["execution_status"] != "uncertain" {
		t.Fatal(status, string(body))
	}
	<-done
	second := fixture()
	second.TaskID = "test.2"
	status, _ = post(t, s, "/api/ilaria/infer", second, token)
	if status != http.StatusServiceUnavailable || calls.Load() != 1 {
		t.Fatalf("uncertain cleanup admitted another provider call: status=%d calls=%d", status, calls.Load())
	}
	status, body = post(t, s, "/api/ilaria/status", r, token)
	if status != http.StatusOK || DecodeCanonical(body, &response) != nil || response.RuntimeMetrics["execution_status"] != "uncertain" {
		t.Fatalf("uncertain state was not retained: status=%d body=%s", status, body)
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e := g.Close(closeCtx); !errors.Is(e, ErrCleanup) {
		t.Fatal("cleanup failure was hidden")
	}
}

func TestGatewayCloseIsBoundedEvenIfTrustedProviderMisbehaves(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	g := configured(t, providerFunc(func(ctx context.Context, _ myriad.CorticalRequest) (myriad.CorticalResponse, error) {
		close(started)
		<-ctx.Done()
		<-release
		return myriad.CorticalResponse{}, ctx.Err()
	}))
	s := httptest.NewTLSServer(g)
	defer s.Close()
	r := fixture()
	done := make(chan struct{})
	go func() { defer close(done); post(t, s, "/api/ilaria/infer", r, strings.Repeat("a", 64)) }()
	<-started
	begin := time.Now()
	e := g.Close(context.Background())
	if e == nil || time.Since(begin) > 2500*time.Millisecond {
		t.Fatal("unbounded or falsely successful close", e)
	}
	close(release)
	<-done
}

type authFunc func(context.Context, string) (Principal, error)

func (f authFunc) Authenticate(c context.Context, t string) (Principal, error) { return f(c, t) }

type providerFunc func(context.Context, myriad.CorticalRequest) (myriad.CorticalResponse, error)

func (f providerFunc) Infer(c context.Context, r myriad.CorticalRequest) (myriad.CorticalResponse, error) {
	return f(c, r)
}
func fixture() myriad.CorticalRequest {
	return myriad.CorticalRequest{ProtocolVersion: 1, TaskID: "test.1", Initiator: "fixture-user", Language: "ro", Modality: "text", Goal: "public canary",
		PrivacyClass: "LOCAL_PRIVATE", DomainSignature: "general", EvidenceRefs: []string{}, HippocampusRefs: []string{}, ToolObservations: []string{},
		Constraints: []string{"no_training", "no_tools"}, DesiredOutputSchema: "CorticalResponse", DeadlineUnixMS: time.Now().Add(30 * time.Second).UnixMilli(), ComputeBudget: 3, RequestedRole: "inference"}
}
func configured(t *testing.T, p Provider) *Gateway {
	t.Helper()
	g, e := New(Config{Authenticator: authFunc(func(_ context.Context, token string) (Principal, error) {
		if token != strings.Repeat("a", 64) {
			return Principal{}, ErrAdmission
		}
		return Principal{UserID: "fixture-user"}, nil
	}),
		Provider: p, MaxConcurrent: 1, MaxRecords: 16, CancelWait: time.Second, AllowCanary: true})
	if e != nil {
		t.Fatal(e)
	}
	return g
}
func post(t *testing.T, s *httptest.Server, path string, r myriad.CorticalRequest, token string) (int, []byte) {
	t.Helper()
	raw, _ := json.Marshal(r)
	q, e := http.NewRequest("POST", s.URL+path, bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	q.Header.Set("Content-Type", "application/json")
	q.Header.Set("Authorization", "Bearer "+token)
	response, e := s.Client().Do(q)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	body, e := io.ReadAll(response.Body)
	if e != nil {
		t.Fatal(e)
	}
	return response.StatusCode, body
}
func TestAdmissionAndStrictCanonical(t *testing.T) {
	if _, e := New(Config{}); e == nil {
		t.Fatal("unconfigured auth admitted")
	}
	r := fixture()
	raw, _ := json.Marshal(r)
	var decoded myriad.CorticalRequest
	if e := DecodeCanonical(raw, &decoded); e != nil {
		t.Fatal(e)
	}
	for _, mutated := range [][]byte{
		append(raw, raw...), bytes.Replace(raw, []byte("\"protocol_version\":1"), []byte("\"protocol_version\":1,\"protocol_version\":1"), 1),
		bytes.Replace(raw, []byte("\"protocol_version\":1"), []byte("\"Protocol_Version\":1"), 1),
		bytes.Replace(raw, []byte("\"protocol_version\":1"), []byte("\"protocol_version\":1e0"), 1),
		bytes.Replace(raw, []byte("\"compute_budget\":3"), []byte("\"compute_budget\":9007199254740992"), 1),
		bytes.Replace(raw, []byte("\"goal\":\"public canary\""), []byte("\"goal\":\"\\ud800\""), 1),
		bytes.Replace(raw, []byte("\"evidence_refs\":[]"), []byte("\"evidence_refs\":null"), 1),
	} {
		if e := DecodeCanonical(mutated, &decoded); e == nil {
			t.Fatalf("unsafe contract accepted: %s", mutated)
		}
	}
	if e := validateRequest(r, "another-user", false); e == nil {
		t.Fatal("cross-account")
	}
	r.PrivacyClass = "SENSITIVE"
	if e := validateRequest(r, "fixture-user", false); e == nil {
		t.Fatal("privacy")
	}
}
func TestCancelPreventsLateStartReplayAndIsSessionBound(t *testing.T) {
	var calls atomic.Int32
	g := configured(t, providerFunc(func(context.Context, myriad.CorticalRequest) (myriad.CorticalResponse, error) {
		calls.Add(1)
		return myriad.CorticalResponse{}, ErrAdmission
	}))
	s := httptest.NewTLSServer(g)
	defer s.Close()
	r := fixture()
	token := strings.Repeat("a", 64)
	status, raw := post(t, s, "/api/ilaria/cancel", r, token)
	if status != 200 {
		t.Fatal(status, string(raw))
	}
	var reply myriad.CorticalResponse
	if e := DecodeCanonical(raw, &reply); e != nil || reply.RuntimeMetrics["execution_status"] != "stopped" {
		t.Fatal(e, string(raw))
	}
	status, _ = post(t, s, "/api/ilaria/infer", r, token)
	if status != 409 || calls.Load() != 0 {
		t.Fatal("late start/replay admitted")
	}
	status, _ = post(t, s, "/api/ilaria/status", r, strings.Repeat("b", 64))
	if status != 401 {
		t.Fatal("other token admitted")
	}
}
func TestCancelWaitsForActualWorkerExitAndBackpressure(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	g := configured(t, providerFunc(func(ctx context.Context, _ myriad.CorticalRequest) (myriad.CorticalResponse, error) {
		close(started)
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		close(stopped)
		return myriad.CorticalResponse{}, ctx.Err()
	}))
	s := httptest.NewTLSServer(g)
	defer s.Close()
	r := fixture()
	token := strings.Repeat("a", 64)
	done := make(chan struct{})
	go func() { defer close(done); post(t, s, "/api/ilaria/infer", r, token) }()
	<-started
	other := r
	other.TaskID = "test.2"
	status, _ := post(t, s, "/api/ilaria/infer", other, token)
	if status != 429 {
		t.Fatal("backpressure")
	}
	status, body := post(t, s, "/api/ilaria/cancel", r, token)
	if status != 200 {
		t.Fatal(status, string(body))
	}
	select {
	case <-stopped:
	default:
		t.Fatal("ack before worker exit")
	}
	var reply myriad.CorticalResponse
	_ = DecodeCanonical(body, &reply)
	if reply.RuntimeMetrics["execution_status"] != "stopped" {
		t.Fatal(string(body))
	}
	<-done
}
func TestBackendAuthenticatorCallsRealPinnedTLSBackendAndRejectsDuplicates(t *testing.T) {
	good := true
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if good {
			io.WriteString(w, "{\"ok\":true,\"user\":{\"userId\":\"fixture-user\",\"role\":\"shopper\",\"email\":null,\"displayName\":null}}")
		} else {
			io.WriteString(w, "{\"ok\":true,\"ok\":false,\"user\":{\"userId\":\"fixture-user\",\"role\":\"shopper\",\"email\":null,\"displayName\":null}}")
		}
	}))
	defer backend.Close()
	auth, e := NewBackendAuthenticator(backend.URL, backend.Client())
	if e != nil {
		t.Fatal(e)
	}
	if principal, e := auth.Authenticate(context.Background(), strings.Repeat("a", 64)); e != nil || principal.UserID != "fixture-user" {
		t.Fatal(e)
	}
	good = false
	if _, e := auth.Authenticate(context.Background(), strings.Repeat("a", 64)); e == nil {
		t.Fatal("duplicate auth profile")
	}
}
func TestRealHTTPSCanonicalIMCCanaryAndNativeWorkerCancellation(t *testing.T) {
	if runtime.GOOS != "windows" && os.Getenv("NEXUS_TEST_CGROUP_ROOT") == "" {
		t.Skip("strict group requires Windows Job Objects or explicit Linux delegated cgroup")
	}
	python := os.Getenv("NEXUS_TEST_PYTHON")
	if python == "" {
		var e error
		python, e = exec.LookPath("python")
		if e != nil {
			t.Fatal("installed Python required", e)
		}
	}
	python, _ = filepath.Abs(python)
	if err := exec.Command(python, "-c", "import torch").Run(); err != nil {
		t.Skip("Python environment lacks PyTorch (torch) dependency for canonical IMC canary:", err)
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "..", "ilaria", "runtime", "mobileprovider", "provider.py"))
	starts := make(chan struct{}, 4)
	provider := ProcessProvider{Process: planprocess.Config{Executable: python, Args: []string{"-B", "-I", script, "--canary"}, MaxThreads: 1, MemoryLimitBytes: 1 << 30, GCPercent: 100, JSONLMaxBytes: MaxBytes},
		Limits: planprocess.Limits{CPUPercent: 50, MemoryBytes: 1 << 30, MaxProcesses: 1, LinuxDelegatedRoot: os.Getenv("NEXUS_TEST_CGROUP_ROOT")}, CPULimit: 30 * time.Second, started: starts}
	g := configured(t, provider)
	s := httptest.NewTLSServer(g)
	defer s.Close()
	r := fixture()
	status, raw := post(t, s, "/api/ilaria/infer", r, strings.Repeat("a", 64))
	if status != 200 {
		t.Fatal(status, string(raw))
	}
	var result myriad.CorticalResponse
	if e := DecodeCanonical(raw, &result); e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(result.Hypothesis, "[TEST IMC canary") || result.ComputeCost < 1 || result.RuntimeMetrics["containment"] == "" || result.RuntimeMetrics["worker_peak_rss_bytes"] == "" {
		t.Fatal("no real model/resource evidence")
	}
	t.Logf("REAL HTTPS IMC canary: forwards=%d model=%s worker_cpu_ns=%s worker_peak_rss_bytes=%s containment=%s energy=unmeasured", result.ComputeCost, result.RuntimeMetrics["model_hash"], result.RuntimeMetrics["worker_cpu_ns"], result.RuntimeMetrics["worker_peak_rss_bytes"], result.RuntimeMetrics["containment"])
	<-starts
	// Cancel an actual owned isolated Python process while importing the canonical CPU runtime.
	r.TaskID = "test.cancel.native"
	r.DeadlineUnixMS = time.Now().Add(30 * time.Second).UnixMilli()
	finished := make(chan struct{})
	go func() { defer close(finished); post(t, s, "/api/ilaria/infer", r, strings.Repeat("a", 64)) }()
	select {
	case <-starts:
	case <-time.After(3 * time.Second):
		t.Fatal("native worker was not actually started")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		status, body := post(t, s, "/api/ilaria/status", r, strings.Repeat("a", 64))
		var current myriad.CorticalResponse
		if status == 200 && DecodeCanonical(body, &current) == nil && current.RuntimeMetrics["execution_status"] == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not enter owned execution")
		}
		time.Sleep(5 * time.Millisecond)
	}
	status, raw = post(t, s, "/api/ilaria/cancel", r, strings.Repeat("a", 64))
	if status != 200 || DecodeCanonical(raw, &result) != nil || result.RuntimeMetrics["execution_status"] != "stopped" {
		t.Fatal("native cancellation not verified", status, string(raw))
	}
	<-finished
}
