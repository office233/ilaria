package imcnetwork

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"swypik-os/core/controlkernel"
	"swypik-os/core/federated"
	"swypik-os/internal/planprocess"
	"sync/atomic"
	"testing"
	"time"
)

const monitorHealthyConsent = `{"opt_in":true,"epoch":1,"scope":"synthetic-public-v1","purpose":"local-network-training"}`

func monitorState(t *testing.T) string {
	t.Helper()
	state := t.TempDir()
	if err := save(filepath.Join(state, "consent.json"), []byte(monitorHealthyConsent)); err != nil {
		t.Fatal(err)
	}
	return state
}

func monitorAwait(t *testing.T, done <-chan error, bound time.Duration) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(bound):
		t.Fatal("consent cancellation did not finish inside its test bound")
		return nil
	}
}

func TestConsentMonitorCheckedDefaultAndBounds(t *testing.T) {
	for _, check := range []struct {
		milliseconds int
		expected     time.Duration
	}{{0, 100 * time.Millisecond}, {10, 10 * time.Millisecond}, {1000, time.Second}} {
		actual, err := checkedConsentPoll(check.milliseconds)
		if err != nil || actual != check.expected {
			t.Fatalf("poll=%d got %v/%v", check.milliseconds, actual, err)
		}
	}
	for _, invalid := range []int{-1, 1, 9, 1001, int(^uint(0) >> 1)} {
		if _, err := checkedConsentPoll(invalid); err == nil {
			t.Fatalf("unbounded or disabled consent poll %d admitted", invalid)
		}
	}
	if err := RunNode(context.Background(), NodeConfig{ConsentPollMS: 1001}, NodeSecrets{}); err == nil || !strings.Contains(err.Error(), "consent poll") {
		t.Fatal("public node did not reject an invalid watch policy before work")
	}
}

func TestConsentMonitorInterruptsInjectedWaitBeforeDispatch(t *testing.T) {
	for _, fault := range []string{"revoked", "epoch", "missing", "malformed", "scope", "purpose"} {
		t.Run(fault, func(t *testing.T) {
			state := monitorState(t)
			parent, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			waiting := make(chan struct{})
			done := make(chan error, 1)
			dispatched := false
			go func() {
				done <- withConsentMonitor(parent, state, 20*time.Millisecond, func(ctx context.Context) error {
					_, err := receiveWithConsent(state, func() ([]byte, error) {
						close(waiting)
						<-ctx.Done()
						return nil, ctx.Err()
					})
					if err == nil {
						dispatched = true
					}
					return err
				})
			}()
			<-waiting
			started := time.Now()
			path := filepath.Join(state, "consent.json")
			var err error
			switch fault {
			case "missing":
				err = os.Remove(path)
			case "malformed":
				err = save(path, []byte(`{"opt_in":`))
			default:
				replacement := monitorHealthyConsent
				switch fault {
				case "revoked":
					replacement = strings.Replace(replacement, "true", "false", 1)
				case "epoch":
					replacement = strings.Replace(replacement, `"epoch":1`, `"epoch":2`, 1)
				case "scope":
					replacement = strings.Replace(replacement, "synthetic-public-v1", "other-scope", 1)
				case "purpose":
					replacement = strings.Replace(replacement, "local-network-training", "other-purpose", 1)
				}
				err = save(path, []byte(replacement))
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = monitorAwait(t, done, 400*time.Millisecond); err == nil || dispatched {
				t.Fatalf("changed consent admitted dispatch: %v/%v", err, dispatched)
			}
			if parent.Err() != nil {
				t.Fatal("watch only finished because of the parent timeout")
			}
			t.Logf("fault=%s polling=20ms observed_stop=%v", fault, time.Since(started))
		})
	}
}

func TestConsentMonitorHealthyReturnAndParentCauseJoin(t *testing.T) {
	state := monitorState(t)
	baseline := runtime.NumGoroutine()
	for i := 0; i < 32; i++ {
		var linked context.Context
		err := withConsentMonitor(context.Background(), state, 10*time.Millisecond, func(ctx context.Context) error {
			linked = ctx
			return nil
		})
		if err != nil || linked.Err() == nil {
			t.Fatalf("healthy callback did not return and stop its monitor: %v", err)
		}
	}
	prior := errors.New("earlier owned parent cancellation")
	parent, cancel := context.WithCancelCause(context.Background())
	waiting := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- withConsentMonitor(parent, state, 20*time.Millisecond, func(ctx context.Context) error {
			close(waiting)
			<-ctx.Done()
			return ctx.Err()
		})
	}()
	<-waiting
	cancel(prior)
	if err := monitorAwait(t, done, 400*time.Millisecond); !errors.Is(err, prior) {
		t.Fatalf("parent cancellation cause replaced: %v", err)
	}
	if err := withConsentMonitor(parent, state, 20*time.Millisecond, func(context.Context) error {
		t.Fatal("pre-canceled parent dispatched work")
		return nil
	}); !errors.Is(err, prior) {
		t.Fatalf("preexisting parent cause replaced: %v", err)
	}
	deadline := time.Now().Add(400 * time.Millisecond)
	for runtime.NumGoroutine() > baseline+2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if count := runtime.NumGoroutine(); count > baseline+2 {
		t.Fatalf("completed scopes leaked monitor goroutines: before=%d after=%d", baseline, count)
	}
}

func TestConsentMonitorRefusesInitialInvalidConsentBeforeCallback(t *testing.T) {
	state := t.TempDir()
	called := false
	if err := withConsentMonitor(context.Background(), state, 20*time.Millisecond, func(context.Context) error { called = true; return nil }); err == nil || called {
		t.Fatal("missing initial consent dispatched callback")
	}
	if err := save(filepath.Join(state, "consent.json"), []byte(strings.Replace(monitorHealthyConsent, `"epoch":1`, `"epoch":2`, 1))); err != nil {
		t.Fatal(err)
	}
	if err := withConsentMonitor(context.Background(), state, 20*time.Millisecond, func(context.Context) error { called = true; return nil }); err == nil || called {
		t.Fatal("changed initial consent epoch dispatched callback")
	}
	if err := save(filepath.Join(state, "consent.json"), []byte(monitorHealthyConsent)); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("earlier node operation failure")
	if err := withConsentMonitor(context.Background(), state, 20*time.Millisecond, func(context.Context) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("healthy monitor replaced an earlier operation failure: %v", err)
	}
}

type monitorFailureCloser struct {
	closeFn func() error
	failure error
	calls   atomic.Int32
}

func (c *monitorFailureCloser) Close() error {
	c.calls.Add(1)
	var err error
	if c.closeFn != nil {
		err = c.closeFn()
	}
	return errors.Join(err, c.failure)
}

func TestConsentMonitorPreservesCancellationCallbackAndCloseErrors(t *testing.T) {
	for _, reason := range []string{"revocation", "parent-cause"} {
		t.Run(reason, func(t *testing.T) {
			state := monitorState(t)
			parentFailure := errors.New("earlier parent cause")
			closeFailure := errors.New("injected owned Job termination failure")
			callbackFailure := errors.New("callback cleanup failure")
			closer := &monitorFailureCloser{failure: closeFailure}
			parent, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			waiting := make(chan struct{})
			done := make(chan error, 1)
			var observedCause error
			go func() {
				done <- withConsentMonitor(parent, state, 20*time.Millisecond, func(ctx context.Context) (resultErr error) {
					join := closeNodeGroupOnCancel(ctx, closer)
					defer func() { resultErr = errors.Join(resultErr, join()) }()
					close(waiting)
					<-ctx.Done()
					observedCause = context.Cause(ctx)
					return callbackFailure
				})
			}()
			<-waiting
			if reason == "parent-cause" {
				cancel(parentFailure)
			} else if err := save(filepath.Join(state, "consent.json"), []byte(strings.Replace(monitorHealthyConsent, "true", "false", 1))); err != nil {
				t.Fatal(err)
			}
			result := monitorAwait(t, done, 400*time.Millisecond)
			for _, expected := range []error{observedCause, closeFailure, callbackFailure} {
				if expected == nil || !errors.Is(result, expected) {
					t.Fatalf("lost cancellation/callback/cleanup error %v from %v", expected, result)
				}
			}
			if reason == "parent-cause" && !errors.Is(result, parentFailure) {
				t.Fatal("first parent cause changed")
			}
			if reason == "revocation" && !strings.Contains(observedCause.Error(), "participation consent canceled") {
				t.Fatal("first consent cause changed")
			}
			if closer.calls.Load() != 1 {
				t.Fatal("Job termination was repeated or omitted")
			}
		})
	}
}

func TestConsentMonitorHealthyJoinRetainsFirstCloseOutcome(t *testing.T) {
	for _, fail := range []bool{false, true} {
		parent, cancel := context.WithCancel(context.Background())
		closer := &monitorFailureCloser{}
		if fail {
			closer.failure = errors.New("normal Job cleanup failure")
		}
		join := closeNodeGroupOnCancel(parent, closer)
		first, second := join(), join()
		cancel()
		if closer.calls.Load() != 1 {
			t.Fatal("normal/repeated join did not close exactly once")
		}
		if fail {
			if !errors.Is(first, closer.failure) || !errors.Is(second, closer.failure) {
				t.Fatal("cached first Close failure disappeared")
			}
		} else if first != nil || second != nil {
			t.Fatalf("healthy join failed: %v/%v", first, second)
		}
	}
	state := monitorState(t)
	cleanupFailure := errors.New("normal deferred cleanup failure")
	closer := &monitorFailureCloser{failure: cleanupFailure}
	result := withConsentMonitor(context.Background(), state, 20*time.Millisecond, func(ctx context.Context) (resultErr error) {
		join := closeNodeGroupOnCancel(ctx, closer)
		defer func() { resultErr = errors.Join(resultErr, join()) }()
		return nil
	})
	if !errors.Is(result, cleanupFailure) || closer.calls.Load() != 1 {
		t.Fatalf("normal deferred cleanup failure was suppressed: %v", result)
	}
}

func TestConsentMonitorLatchedCancellationCannotCommitRollback(t *testing.T) {
	f := rollbackTestFixture(t, t.TempDir())
	parent, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	waiting := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- withConsentMonitor(parent, f.directory, 20*time.Millisecond, func(ctx context.Context) error {
			close(waiting)
			<-ctx.Done()
			// Restoring the file after observed revocation cannot resurrect this
			// canceled node or convert its prepared intent into a new commit.
			if err := save(filepath.Join(f.directory, "consent.json"), []byte(monitorHealthyConsent)); err != nil {
				return err
			}
			return publishRollback(ctx, f.directory, f.kernel, f.credential, f.token, f.intent, f.notice, f.issuer)
		})
	}()
	<-waiting
	if err := save(filepath.Join(f.directory, "consent.json"), []byte(strings.Replace(monitorHealthyConsent, "true", "false", 1))); err != nil {
		t.Fatal(err)
	}
	if err := monitorAwait(t, done, 400*time.Millisecond); err == nil || !strings.Contains(err.Error(), "participation consent canceled") {
		t.Fatalf("lost revocation cause: %v", err)
	}
	intent, ok := f.kernel.IntentByKey(f.notice.Certificate.RollbackIntentKey)
	if !ok || intent.State != controlkernel.IntentPrepared {
		t.Fatal("canceled scope advanced its prepared intent")
	}
	active, err := os.ReadFile(filepath.Join(f.directory, "active.json"))
	if err != nil || string(active) != f.before.Parent {
		t.Fatal("canceled scope changed active checkpoint")
	}
	progress, err := os.ReadFile(filepath.Join(f.directory, "progress.json"))
	if err != nil || !bytes.Equal(progress, encode(f.before)) {
		t.Fatal("canceled scope changed sequence or lineage")
	}
	if _, err = os.Stat(filepath.Join(f.directory, "pending.json")); !os.IsNotExist(err) {
		t.Fatal("canceled scope created publication evidence")
	}
}

func monitorSocketPair(ctx context.Context) (*federated.SocketSession, func(), error) {
	aListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	bListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = aListener.Close()
		return nil, nil, err
	}
	aEndpoint, bEndpoint := aListener.Addr().String(), bListener.Addr().String()
	_ = aListener.Close()
	_ = bListener.Close()
	ap, ak, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	bp, bk, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	members := []federated.BootstrapMember{{ID: "issuer", Endpoint: aEndpoint, PublicKey: ap, Role: "issuer"}, {ID: "proposer", Endpoint: bEndpoint, PublicKey: bp, Role: "worker"}}
	a, err := federated.NewTransportMesh("issuer", "synthetic-cpu").ConfigureSocket(federated.SocketConfig{LocalID: "issuer", PrivateKey: ak, Members: members, Timeout: 5 * time.Second, TrafficBytes: 1 << 20})
	if err != nil {
		return nil, nil, err
	}
	b, err := federated.NewTransportMesh("proposer", "synthetic-cpu").ConfigureSocket(federated.SocketConfig{LocalID: "proposer", PrivateKey: bk, Members: members, Timeout: 5 * time.Second, TrafficBytes: 1 << 20})
	if err != nil {
		_ = a.Close()
		return nil, nil, err
	}
	cleanup := func() { _ = a.Close(); _ = b.Close() }
	if err = a.Listen(); err != nil {
		cleanup()
		return nil, nil, err
	}
	setup, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	type acceptance struct {
		session *federated.SocketSession
		err     error
	}
	accepted := make(chan acceptance, 1)
	go func() { session, err := a.Accept(setup); accepted <- acceptance{session, err} }()
	client, err := b.Dial(setup, "issuer")
	if err != nil {
		cancel()
		cleanup()
		<-accepted
		return nil, nil, err
	}
	server := <-accepted
	if server.err != nil {
		_ = client.Close()
		cleanup()
		return nil, nil, server.err
	}
	return server.session, func() { _ = client.Close(); _ = server.session.Close(); cleanup() }, nil
}

// The trusted child is this test binary, selected only by explicit arguments.
// It has no model, private state, environment exception or external executable.
func TestConsentMonitorOwnedChildHelper(t *testing.T) {
	args := []string(nil)
	for i, arg := range os.Args {
		if arg == "consent-monitor-child" {
			args = os.Args[i+1:]
			break
		}
	}
	if len(args) != 3 {
		return
	}
	mode, contribution, heartbeat := args[0], args[1], args[2]
	if mode == "heartbeat" {
		for i := 0; i < 1000; i++ {
			_ = os.WriteFile(heartbeat, []byte(fmt.Sprint(i)), 0600)
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(0)
	}
	executable, err := os.Executable()
	if err != nil {
		os.Exit(20)
	}
	child := exec.Command(executable, "-test.run=^TestConsentMonitorOwnedChildHelper$", "--", "consent-monitor-child", "heartbeat", contribution, heartbeat)
	if err := child.Start(); err != nil {
		os.Exit(21)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(heartbeat); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = child.Process.Kill()
			os.Exit(22)
		}
		time.Sleep(5 * time.Millisecond)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "pid": os.Getpid(), "child_pid": child.Process.Pid})
	var request map[string]any
	if json.NewDecoder(os.Stdin).Decode(&request) != nil {
		os.Exit(23)
	}
	if mode == "complete" {
		fmt.Fprintln(os.Stdout, `{"completed":true}`)
		_ = child.Process.Kill()
		_ = child.Wait()
		os.Exit(0)
	}
	fmt.Fprintln(os.Stdout, `{"working":true}`)
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
	}
	_ = os.WriteFile(contribution, []byte("late contribution"), 0600)
	fmt.Fprintln(os.Stdout, `{"completed":true}`)
	_ = child.Process.Kill()
	_ = child.Wait()
	os.Exit(0)
}

func TestConsentMonitorHealthyOwnedProtocolCompletion(t *testing.T) {
	state := monitorState(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 100, MemoryBytes: 256 << 20, MaxProcesses: 2})
	if err != nil {
		if errors.Is(err, planprocess.ErrKernelLimitsUnavailable) && runtime.GOOS != "windows" {
			t.Skipf("strict test Job unavailable: %v", err)
		}
		t.Fatal(err)
	}
	defer group.Close()
	parent, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = withConsentMonitor(parent, state, 20*time.Millisecond, func(ctx context.Context) (resultErr error) {
		cleanupGroup := group.Close
		defer func() { resultErr = errors.Join(resultErr, cleanupGroup()) }()
		p, err := group.Start(ctx, planprocess.Config{Executable: executable, Args: []string{"-test.run=^TestConsentMonitorOwnedChildHelper$", "--", "consent-monitor-child", "complete", filepath.Join(state, "unused-contribution.txt"), filepath.Join(state, "healthy-heartbeat.txt")}, Directory: state, MaxThreads: 1, MemoryLimitBytes: 128 << 20, GCPercent: 100})
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, p.Close()) }()
		cleanupGroup = closeNodeGroupOnCancel(ctx, group)
		for i, key := range []string{"ready", "completed"} {
			if i == 1 {
				if err = p.SendJSON(ctx, map[string]any{"work": true}); err != nil {
					return err
				}
			}
			raw, err := p.ReadLine(ctx)
			if err != nil {
				return err
			}
			var frame map[string]any
			if err = json.Unmarshal(raw, &frame); err != nil || frame[key] != true {
				return fmt.Errorf("healthy owned protocol missing %s", key)
			}
		}
		return p.Wait(ctx)
	})
	if err != nil || parent.Err() != nil {
		t.Fatalf("healthy completion became cleanup failure: %v", err)
	}
}

func TestConsentMonitorCancelsOwnedActiveJobAndDescendant(t *testing.T) {
	for _, reason := range []string{"revoke", "blocked-receive", "held-callback", "parent-deadline", "cleanup-error"} {
		t.Run(reason, func(t *testing.T) {
			state := monitorState(t)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			group, err := planprocess.OpenGroup(planprocess.Limits{CPUPercent: 100, MemoryBytes: 256 << 20, MaxProcesses: 2})
			if err != nil {
				if errors.Is(err, planprocess.ErrKernelLimitsUnavailable) && runtime.GOOS != "windows" {
					t.Skipf("strict test Job unavailable: %v", err)
				}
				t.Fatal(err)
			}
			defer group.Close()
			contribution := filepath.Join(state, "late-contribution.txt")
			heartbeat := filepath.Join(state, "owned-child-heartbeat.txt")
			parent, cancel := context.WithCancel(context.Background())
			if reason == "parent-deadline" {
				cancel()
				parent, cancel = context.WithTimeout(context.Background(), 600*time.Millisecond)
			}
			defer cancel()
			working := make(chan struct{})
			done := make(chan error, 1)
			var child *planprocess.Process
			var linked context.Context
			active := false
			closeFailure := errors.New("injected owned Job Close error after actual termination")
			callbackFailure := errors.New("owned callback cleanup failure")
			var injected *monitorFailureCloser
			release := make(chan struct{})
			released := false
			defer func() {
				if !released {
					close(release)
				}
			}()
			go func() {
				done <- withConsentMonitor(parent, state, 20*time.Millisecond, func(ctx context.Context) (resultErr error) {
					linked = ctx
					// Match RunNode's one error-preserving Group cleanup owner.
					cleanupGroup := group.Close
					defer func() { resultErr = errors.Join(resultErr, cleanupGroup()) }()
					p, err := group.Start(ctx, planprocess.Config{Executable: executable, Args: []string{"-test.run=^TestConsentMonitorOwnedChildHelper$", "--", "consent-monitor-child", "active", contribution, heartbeat}, Directory: state, MaxThreads: 1, MemoryLimitBytes: 128 << 20, GCPercent: 100})
					if err != nil {
						close(working)
						return err
					}
					child = p
					defer func() { resultErr = errors.Join(resultErr, p.Close()) }()
					var target nodeGroupCloser = group
					if reason == "cleanup-error" {
						injected = &monitorFailureCloser{closeFn: group.Close, failure: closeFailure}
						target = injected
					}
					cleanupGroup = closeNodeGroupOnCancel(ctx, target)
					for i := 0; i < 2; i++ {
						if i == 1 {
							if err = p.SendJSON(ctx, map[string]any{"work": true}); err != nil {
								close(working)
								return err
							}
						}
						var raw []byte
						if raw, err = p.ReadLine(ctx); err != nil {
							close(working)
							return err
						}
						var frame map[string]any
						key := "ready"
						if i == 1 {
							key = "working"
						}
						if err = json.Unmarshal(raw, &frame); err != nil || frame[key] != true {
							close(working)
							return fmt.Errorf("owned helper did not enter %s: %s", key, raw)
						}
					}
					var session *federated.SocketSession
					if reason == "blocked-receive" {
						var cleanup func()
						session, cleanup, err = monitorSocketPair(ctx)
						if err != nil {
							close(working)
							return err
						}
						defer cleanup()
					}
					active = true
					close(working)
					if reason == "held-callback" {
						<-ctx.Done()
						<-release
						return ctx.Err()
					}
					if session != nil {
						_, err = receiveWithConsent(state, func() ([]byte, error) { return session.Receive(ctx) })
						return err
					}
					_, err = p.ReadLine(ctx)
					if reason == "cleanup-error" {
						return errors.Join(err, callbackFailure)
					}
					return err
				})
			}()
			select {
			case <-working:
			case <-time.After(2 * time.Second):
				cancel()
				t.Fatal("owned helper did not begin active work")
			}
			if !active {
				cancel()
				err = monitorAwait(t, done, time.Second)
				t.Fatalf("fixture did not enter active work: %v", err)
			}
			started := time.Now()
			if reason != "parent-deadline" {
				if err = save(filepath.Join(state, "consent.json"), []byte(strings.Replace(monitorHealthyConsent, "true", "false", 1))); err != nil {
					t.Fatal(err)
				}
			}
			if reason == "held-callback" {
				select {
				case <-linked.Done():
				case <-time.After(400 * time.Millisecond):
					t.Fatal("monitor failed to cancel held callback")
				}
				// The node callback has deliberately not returned. Its owned Job
				// still must terminate descendants without waiting for defers.
				time.Sleep(40 * time.Millisecond)
				before, err := os.ReadFile(heartbeat)
				if err != nil {
					t.Fatal(err)
				}
				time.Sleep(40 * time.Millisecond)
				after, err := os.ReadFile(heartbeat)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("owned descendant waited for node callback cleanup after cancellation")
				}
				close(release)
				released = true
			}
			if err = monitorAwait(t, done, time.Second); err == nil || child == nil || linked.Err() == nil {
				t.Fatalf("active Job continued after cancellation: %v", err)
			}
			stoppedAt := time.Now()
			stopLatency := stoppedAt.Sub(started)
			if reason == "parent-deadline" {
				deadline, _ := parent.Deadline()
				stopLatency = stoppedAt.Sub(deadline)
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("parent deadline was replaced with consent cancellation: %v", err)
				}
			} else if !strings.Contains(err.Error(), "participation consent canceled") || parent.Err() != nil {
				t.Fatalf("consent revocation lost its distinct cause: %v", err)
			}
			if reason == "cleanup-error" && (!errors.Is(err, closeFailure) || !errors.Is(err, callbackFailure) || injected.calls.Load() != 1) {
				t.Fatalf("actual cancellation lost Close/callback failure: %v", err)
			}
			if stopLatency > 400*time.Millisecond {
				t.Fatalf("stop/cleanup exceeded scheduling test bound: %v", stopLatency)
			}
			waitCtx, stopWait := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer stopWait()
			if err = child.Wait(waitCtx); err == nil || waitCtx.Err() != nil {
				t.Fatalf("owned leader was not already reaped: %v", err)
			}
			if _, err := os.Stat(contribution); !os.IsNotExist(err) {
				t.Fatal("revoked/timed-out computation emitted a late contribution")
			}
			before, err := os.ReadFile(heartbeat)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(60 * time.Millisecond)
			after, err := os.ReadFile(heartbeat)
			if err != nil || string(before) != string(after) {
				t.Fatal("owned descendant continued after existing Job cleanup")
			}
			t.Logf("reason=%s polling=20ms owned_stop_and_join=%v mechanism=%s", reason, stopLatency, group.Mechanism())
		})
	}
}

func TestConsentMonitorPublicNodeUsesLinkedContext(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "adapter.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	groupStart, groupCancellation := token.NoPos, token.NoPos
	groupCleanupJoined, workerCleanupJoined, namedResult := false, false, false
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if function.Name.Name == "runNode" {
			if function.Type.Results != nil && len(function.Type.Results.List) == 1 && len(function.Type.Results.List[0].Names) == 1 && function.Type.Results.List[0].Names[0].Name == "resultErr" {
				namedResult = true
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "closeNodeGroupOnCancel" && len(call.Args) == 2 {
					ctx, ctxOK := call.Args[0].(*ast.Ident)
					group, groupOK := call.Args[1].(*ast.Ident)
					if ctxOK && groupOK && ctx.Name == "ctx" && group.Name == "group" {
						groupCancellation = call.Pos()
					}
				}
				if member, ok := call.Fun.(*ast.SelectorExpr); ok && member.Sel.Name == "Start" {
					if owner, ok := member.X.(*ast.Ident); ok && owner.Name == "group" {
						groupStart = call.Pos()
					}
				}
				if member, ok := call.Fun.(*ast.SelectorExpr); ok && member.Sel.Name == "Join" && len(call.Args) == 2 {
					result, ok := call.Args[0].(*ast.Ident)
					cleanup, cleanupOK := call.Args[1].(*ast.CallExpr)
					if ok && cleanupOK && result.Name == "resultErr" {
						if name, ok := cleanup.Fun.(*ast.Ident); ok && name.Name == "cleanupGroup" {
							groupCleanupJoined = true
						}
						if target, ok := cleanup.Fun.(*ast.SelectorExpr); ok && target.Sel.Name == "Close" {
							if owner, ok := target.X.(*ast.Ident); ok && owner.Name == "worker" {
								workerCleanupJoined = true
							}
						}
					}
				}
				return true
			})
			continue
		}
		if function.Name.Name != "RunNode" {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			name, ok := call.Fun.(*ast.Ident)
			if !ok || name.Name != "withConsentMonitor" || len(call.Args) != 4 {
				return true
			}
			callback, ok := call.Args[3].(*ast.FuncLit)
			if !ok || len(callback.Type.Params.List) != 1 || len(callback.Type.Params.List[0].Names) != 1 {
				return true
			}
			linkedName := callback.Type.Params.List[0].Names[0].Name
			ast.Inspect(callback.Body, func(node ast.Node) bool {
				invocation, ok := node.(*ast.CallExpr)
				if !ok || len(invocation.Args) != 3 {
					return true
				}
				callee, ok := invocation.Fun.(*ast.Ident)
				argument, argOK := invocation.Args[0].(*ast.Ident)
				if ok && argOK && callee.Name == "runNode" && argument.Name == linkedName {
					found = true
				}
				return true
			})
			return true
		})
	}
	if !found {
		t.Fatal("public node bypasses the monitored context for socket/worker operations")
	}
	if !groupStart.IsValid() || !groupCancellation.IsValid() || groupCancellation <= groupStart {
		t.Fatal("node does not bind its owned Job cancellation after platform activation")
	}
	if !namedResult || !groupCleanupJoined || !workerCleanupJoined {
		t.Fatal("node drops deferred Group/worker cleanup errors")
	}
}
