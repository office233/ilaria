//go:build windows

// SwypikOS is a native Windows desktop application. It does not start an HTTP
// server, launch a browser, or require a JavaScript runtime.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"swypik-os/config"
	"swypik-os/core/agent"
	"swypik-os/core/coder"
	"swypik-os/core/compute"
	"swypik-os/core/ilaria"
	resourcepolicy "swypik-os/core/resource"
	"swypik-os/core/search"
	"swypik-os/core/service"
	"swypik-os/ui/desktop"
	"swypik-os/ui/engine"
)

var buildVersion = "dev"
var desktopGUI = "false"

type launchOptions struct {
	version   bool
	check     bool
	workspace string
	dataDir   string
	ilariaURL string // overrides settings.json when set
}

func parseLaunchOptions(args []string, output io.Writer) (launchOptions, error) {
	var options launchOptions
	flags := flag.NewFlagSet("swypik-os", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.BoolVar(&options.version, "version", false, "Print build version and exit")
	flags.BoolVar(&options.check, "check", false, "Print startup configuration without opening a window, writing files or using the network")
	flags.StringVar(&options.workspace, "workspace", os.Getenv("SWYPIK_WORKSPACE_DIR"), "Workspace the agent may read and change (default: settings.json, then <data-dir>/workspace)")
	flags.StringVar(&options.dataDir, "data-dir", os.Getenv("SWYPIK_STATE_DIR"), "Data directory (default: LocalAppData/SwypikOS)")
	flags.StringVar(&options.ilariaURL, "ilaria-url", "", "Ilaria service origin; overrides settings.json for this launch")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, fmt.Errorf("unexpected positional arguments: %v", flags.Args())
	}
	if options.version && options.check {
		return options, fmt.Errorf("-version and -check cannot be combined")
	}
	if options.ilariaURL != "" {
		u, err := config.ValidateIlariaURL(options.ilariaURL)
		if err != nil {
			return options, err
		}
		options.ilariaURL = u
	}
	return options, nil
}

func resolveDirectories(options launchOptions) (workspace, dataDir string, err error) {
	dataDir = options.dataDir
	if dataDir == "" {
		cache, cacheErr := os.UserCacheDir()
		if cacheErr != nil {
			return "", "", fmt.Errorf("locate per-user data directory: %w", cacheErr)
		}
		dataDir = filepath.Join(cache, "SwypikOS")
	}
	if dataDir, err = filepath.Abs(dataDir); err != nil {
		return "", "", err
	}
	workspace = options.workspace
	if workspace == "" {
		workspace = filepath.Join(dataDir, "workspace")
	}
	if workspace, err = filepath.Abs(workspace); err != nil {
		return "", "", err
	}
	for _, path := range []string{workspace, dataDir} {
		info, statErr := os.Stat(path)
		if statErr != nil && !os.IsNotExist(statErr) {
			return "", "", fmt.Errorf("inspect directory: %w", statErr)
		}
		if statErr == nil && !info.IsDir() {
			return "", "", fmt.Errorf("not a directory: %s", path)
		}
	}
	return workspace, dataDir, nil
}

func openDesktopLog(dataDir string) (*os.File, error) {
	dir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}
	// The timestamp and PID keep logs sortable; CreateTemp's random suffix makes
	// the name unique even when two calls read the same clock tick, and it
	// creates the file exclusively with 0600 permissions.
	pattern := fmt.Sprintf("desktop-%s-%d-*.log", time.Now().Format("20060102-150405.000000000"), os.Getpid())
	return os.CreateTemp(dir, pattern)
}

// desktopLimits bound one agent run: enough steps for read-edit-test cycles,
// with a per-tool timeout suited to builds and test suites.
var desktopLimits = agent.Limits{MaxSteps: 16, Duration: 30 * time.Minute, ToolTimeout: time.Minute, MaxOutputBytes: 64 * 1024}

func run(args []string, output io.Writer) error {
	selection := resourcepolicy.DefaultSelection()
	policy := selection.Policy
	resourcepolicy.ApplyRuntime(policy)
	options, err := parseLaunchOptions(args, output)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	if options.version {
		_, err := fmt.Fprintf(output, "SwypikOS %s (native Windows/%s; %s)\n", buildVersion, runtime.GOARCH, runtime.Version())
		return err
	}
	_, dataDir, err := resolveDirectories(options)
	if err != nil {
		return err
	}
	settingsPath := filepath.Join(dataDir, "settings.json")
	settings, err := config.LoadSettings(settingsPath)
	if err != nil {
		return err
	}
	if options.workspace == "" && settings.Workspace != "" {
		options.workspace = settings.Workspace
	}
	workspace, dataDir, err := resolveDirectories(options)
	if err != nil {
		return err
	}
	if options.ilariaURL != "" {
		settings.IlariaURL = options.ilariaURL
	}
	tokenFile := settings.IlariaTokenFile
	if tokenFile == "" {
		tokenFile = filepath.Join(dataDir, "ilaria.token")
	}
	token, err := config.ResolveToken(tokenFile)
	if err != nil {
		return fmt.Errorf("read Ilaria token: %w", err)
	}
	if options.check {
		return json.NewEncoder(output).Encode(struct {
			Version         string `json:"version"`
			Runtime         string `json:"runtime"`
			Workspace       string `json:"workspace"`
			DataDir         string `json:"data_dir"`
			Settings        string `json:"settings"`
			IlariaURL       string `json:"ilaria_url"`
			TokenConfigured bool   `json:"token_configured"`
			Browser         bool   `json:"browser_required"`
			Listener        bool   `json:"http_listener"`
			ResourceProfile string `json:"resource_profile"`
			MemoryLimitMB   int    `json:"memory_limit_mb"`
			BackgroundCPU   int    `json:"background_cpu_percent"`
			BackgroundGPU   int    `json:"background_gpu_percent"`
			ResourceSource  string `json:"resource_source"`
			ResourceReason  string `json:"resource_reason"`
			ResourcePolicy  any    `json:"resource_policy"`
		}{buildVersion, "win32", workspace, dataDir, settingsPath, settings.IlariaURL, token != "", false, false, string(policy.Profile), policy.MemoryLimitMB, policy.MaxBackgroundCPUPercent, policy.MaxBackgroundGPUPercent, selection.Source, selection.Reason, policy.Contract()})
	}

	file, err := openDesktopLog(dataDir)
	if err != nil {
		return err
	}
	defer file.Close()
	logger := log.New(file, "SwypikOS ", log.LstdFlags|log.Lmicroseconds)
	logger.Printf("Starting native Windows desktop build=%s arch=%s resource_profile=%s source=%s reason=%s", buildVersion, runtime.GOARCH, policy.Profile, selection.Source, selection.Reason)
	if err := os.MkdirAll(workspace, 0700); err != nil {
		logger.Printf("Workspace unavailable: %v", err)
		return err
	}

	index, err := search.Open(filepath.Join(dataDir, "search-index.jsonl"))
	if err != nil {
		logger.Printf("Search index unavailable: %v", err)
		return fmt.Errorf("open search index: %w", err)
	}
	defer index.Close()
	for _, w := range index.Warnings() {
		logger.Print(w)
	}
	if n, err := index.ImportLegacy(filepath.Join(dataDir, "search-index.json")); err != nil {
		logger.Printf("Legacy index not migrated: %v", err)
	} else if n > 0 {
		logger.Printf("Migrated %d documents from the legacy index", n)
	}

	chat := ilaria.NewEngine()
	// The endpoint can change from Settings while a health check runs.
	var backend atomic.Pointer[ilaria.LocalBackend]
	backend.Store(ilaria.NewCloudBackend(settings.IlariaURL, token))
	chat.SetBackend(backend.Load())

	store, err := agent.OpenFileStore(filepath.Join(dataDir, "agent"))
	if err != nil {
		return fmt.Errorf("SwypikOS is already running or its state is unavailable: %w", err)
	}
	defer store.Close()
	tools := append(agent.WorkspaceTools(workspace, coder.Run), service.SearchTool(index))
	manager, err := agent.NewPersistent(agent.JSONPlanner{Complete: chat.Complete}, tools, desktopLimits, store)
	if err != nil {
		return fmt.Errorf("agent state: %w", err)
	}
	defer manager.Close()

	var app *engine.ShellApp
	ctl := desktop.New(desktop.Deps{
		Chat: chat, Agent: manager, Search: index, Workspace: workspace,
		SettingsPath: settingsPath, Settings: settings, TokenConfigured: token != "",
		Health: func(ctx context.Context) error { return backend.Load().Health(ctx) },
		ApplyIlaria: func(u string) error {
			backend.Store(ilaria.NewCloudBackend(u, token))
			chat.SetBackend(backend.Load())
			logger.Printf("Ilaria endpoint changed to %s", u)
			return nil
		},
		Compute: compute.Inspect,
		Notify: func() {
			if app != nil {
				app.Notify()
			}
		},
	})
	app = engine.NewShellApp(ctl)
	app.SetLifecycleReporter(func(stage string) { logger.Print(stage) })
	logger.Printf("Workspace=%s Ilaria=%s token=%v indexed=%d", workspace, settings.IlariaURL, token != "", index.Count())
	if err := app.Run(); err != nil {
		logger.Printf("Native desktop failed: %v", err)
		return err
	}
	logger.Print("Native desktop closed cleanly")
	return nil
}

func main() {
	// The desktop's live heap is ~2 MB. Collect earlier and aim for a small
	// soft ceiling so idle memory stays close to the Win32 floor.
	debug.SetGCPercent(50)
	debug.SetMemoryLimit(24 << 20)
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "SwypikOS:", err)
		if desktopGUI == "true" {
			title, _ := syscall.UTF16PtrFromString("SwypikOS - startup error")
			message, _ := syscall.UTF16PtrFromString(strings.ReplaceAll(err.Error(), "\x00", " "))
			syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
		}
		os.Exit(1)
	}
}
