// mobile-gateway serves canonical Ilaria requests; no auth or model is enabled by default.
package main

import (
	"context"
	"flag"
	"fmt"
	"golang.org/x/net/netutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"swypik-os/internal/mobilegateway"
	"swypik-os/internal/planprocess"
)

func run() error {
	auth := flag.String("auth-backend", "", "Explicit approved HTTPS backend validating /api/auth/me")
	python := flag.String("python", "", "Explicit installed Python executable (otherwise operator PATH lookup)")
	script := flag.String("provider", "", "Absolute canonical Ilaria mobileprovider/provider.py")
	library := flag.String("public-library-root", "", "Optional installed public Python dependency directory")
	canary := flag.Bool("canary", false, "Explicit synthetic IMC integration test; not promoted model")
	listen := flag.String("listen", "127.0.0.1:8443", "TLS listening address")
	cert := flag.String("cert", "", "Operator TLS certificate file")
	key := flag.String("key", "", "Operator TLS private key file; never logged")
	cpu := flag.Uint("cpu-percent", 25, "Worker group hard CPU percent, 1..100")
	memory := flag.Uint64("memory-bytes", 1<<30, "Worker group aggregate hard memory ceiling")
	delegated := flag.String("linux-delegated-root", "", "Operator delegated cgroup v2 root; required on Linux")
	connections := flag.Int("max-connections", 16, "Bounded gateway TCP connections, 1..128; child limits do not cap the host")
	flag.Parse()
	if *connections < 1 || *connections > 128 {
		return fmt.Errorf("invalid connection budget")
	}
	if *auth == "" || *cert == "" || *key == "" || !filepath.IsAbs(*script) || !*canary {
		return fmt.Errorf("explicit auth backend/TLS/provider and --canary required; approved production provider not yet wired by CLI")
	}
	authenticator, e := mobilegateway.NewBackendAuthenticator(*auth, nil)
	if e != nil {
		return fmt.Errorf("invalid auth backend")
	}
	if *python == "" {
		*python, e = exec.LookPath("python")
		if e != nil {
			return fmt.Errorf("installed Python executable required")
		}
	}
	*python, e = filepath.Abs(*python)
	if e != nil {
		return e
	}
	args := []string{"-B", "-I", *script, "--canary"}
	if *library != "" {
		if !filepath.IsAbs(*library) {
			return fmt.Errorf("public library root must be absolute")
		}
		args = append(args, "--public-library-root", *library)
	}
	provider := mobilegateway.ProcessProvider{
		Process: planprocess.Config{Executable: *python, Args: args, MaxThreads: 1, MemoryLimitBytes: int64(*memory), GCPercent: 100, JSONLMaxBytes: mobilegateway.MaxBytes},
		Limits:  planprocess.Limits{CPUPercent: uint32(*cpu), MemoryBytes: *memory, MaxProcesses: 1, LinuxDelegatedRoot: *delegated}, CPULimit: 30 * time.Second}
	if *cpu < 1 || *cpu > 100 || *memory < 1 || *memory > uint64(1<<63-1) {
		return fmt.Errorf("invalid explicit resource limits")
	}
	probe, e := planprocess.OpenGroup(provider.Limits)
	if e != nil {
		return fmt.Errorf("strict worker limits unavailable: %w", e)
	}
	if e = probe.Close(); e != nil {
		return e
	}
	handler, e := mobilegateway.New(mobilegateway.Config{Authenticator: authenticator, Provider: provider, MaxConcurrent: 1, MaxRecords: 128, CancelWait: 2 * time.Second, AllowCanary: true})
	if e != nil {
		return e
	}
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 4 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	listener, e := net.Listen("tcp", *listen)
	if e != nil {
		return e
	}
	listener = netutil.LimitListener(listener, *connections)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = handler.Close(shutdown)
		_ = server.Shutdown(shutdown)
		_ = server.Close()
	}()
	e = server.ServeTLS(listener, *cert, *key)
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "mobile gateway refused configuration or execution:", e)
		os.Exit(2)
	}
}
