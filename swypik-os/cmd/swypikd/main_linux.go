//go:build linux

// swypikd is a userspace OS service, not a kernel or a browser server.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"swypik-os/core/agent"
	"swypik-os/core/ilaria"
	resourcepolicy "swypik-os/core/resource"
	"swypik-os/core/search"
	"swypik-os/core/service"
)

func main() {
	resourcepolicy.ApplyRuntime(resourcepolicy.Default())
	socket := flag.String("socket", "/run/swypik/control.sock", "Private Unix socket")
	root := flag.String("workspace", "/home/swypik/Workspace", "Explicit workspace")
	index := flag.String("index", "/var/lib/swypik/index.jsonl", "Search index path (append-only log)")
	state := flag.String("state-dir", "/var/lib/swypik/agent", "Private directory for last-run checkpoints")
	endpoint := flag.String("ilaria-url", "http://127.0.0.1:8091", "Ilaria loopback HTTP or authenticated HTTPS endpoint")
	flag.Parse()
	if os.Geteuid() == 0 {
		fmt.Fprintln(os.Stderr, "Refusing to run the agent service as root")
		os.Exit(1)
	}
	if err := run(*socket, *root, *index, *state, *endpoint); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(socket, root, index, state, endpoint string) error {
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		return err
	}
	store, err := agent.OpenFileStore(state)
	if err != nil {
		return err
	}
	defer store.Close()
	e, err := search.Open(index)
	if err != nil {
		return err
	}
	defer e.Close()
	for _, w := range e.Warnings() {
		fmt.Fprintln(os.Stderr, w)
	}
	if n, err := e.ImportLegacy(filepath.Join(filepath.Dir(index), "index.json")); err != nil {
		fmt.Fprintln(os.Stderr, err)
	} else if n > 0 {
		fmt.Println("migrated", n, "documents from the legacy index")
	}
	backend := ilaria.NewCloudBackend(endpoint, os.Getenv("ILARIA_API_TOKEN"))
	planner := agent.JSONPlanner{Complete: func(ctx context.Context, p string) (string, error) { return backend.Chat(ctx, p, nil) }}
	tools := append(agent.ReadOnlyTools(root), service.SearchTool(e))
	manager, err := agent.NewPersistent(planner, tools, agent.Limits{}, store)
	if err != nil {
		return err
	}
	defer manager.Close()
	// Never unlink an arbitrary path or steal another daemon's socket.
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer ln.Close()
	if err := os.Chmod(socket, 0600); err != nil {
		return err
	}
	srv := &http.Server{Handler: &service.Service{Agent: manager, Search: e, Workspace: root}, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 140 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// serverDone also stops the shutdown worker when Serve exits unexpectedly.
	serverDone := make(chan struct{})
	defer close(serverDone)
	go func() {
		select {
		case <-ctx.Done():
		case <-serverDone:
			return
		}
		manager.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	recovered := false
	if r := manager.Snapshot(); r != nil {
		recovered = true
	}
	fmt.Printf("SWYPIK_DAEMON_READY uid=%d ipc=unix indexed=%d recovered=%v\n", os.Getuid(), e.Count(), recovered)
	err = srv.Serve(ln)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
