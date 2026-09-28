//go:build windows

// SwypikOS is a native Windows desktop application. It does not start an HTTP
// server, launch a browser, or require a JavaScript runtime.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"swypik-os/config"
	"swypik-os/core/coder"
	"swypik-os/core/ilaria"
	"swypik-os/core/notifications"
	"swypik-os/core/search"
	"swypik-os/core/swarm"
	"swypik-os/ui/engine"
	"swypik-os/ui/views"
)

var buildVersion = "dev"
var desktopGUI = "false"

type launchOptions struct {
	version   bool
	check     bool
	workspace string
	dataDir   string
	ilariaURL string
}

func parseLaunchOptions(args []string, output io.Writer) (launchOptions, error) {
	var options launchOptions
	flags := flag.NewFlagSet("swypik-os", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.BoolVar(&options.version, "version", false, "Print build version and exit")
	flags.BoolVar(&options.check, "check", false, "Print native startup configuration without opening a window or making network requests")
	flags.StringVar(&options.workspace, "workspace", os.Getenv("SWYPIK_WORKSPACE_DIR"), "Workspace directory (default: per-user SwypikOS workspace)")
	flags.StringVar(&options.dataDir, "data-dir", os.Getenv("SWYPIK_STATE_DIR"), "Data directory (default: LocalAppData/SwypikOS)")
	flags.StringVar(&options.ilariaURL, "ilaria-url", "http://127.0.0.1:8091", "Ilaria inference endpoint; contacted only after an explicit AI request")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, fmt.Errorf("unexpected positional arguments: %v", flags.Args())
	}
	if options.version && options.check {
		return options, fmt.Errorf("-version and -check cannot be combined")
	}
	u, err := url.Parse(options.ilariaURL)
	if err != nil || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return options, fmt.Errorf("invalid Ilaria endpoint: expected an origin without credentials, query, or path")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return options, fmt.Errorf("Ilaria requires loopback HTTP or authenticated HTTPS")
	}
	options.ilariaURL = strings.TrimRight(options.ilariaURL, "/")
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
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return "", "", err
	}
	workspace = options.workspace
	if workspace == "" {
		workspace = filepath.Join(dataDir, "workspace")
	}
	workspace, err = filepath.Abs(workspace)
	if err != nil {
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
	name := fmt.Sprintf("desktop-%s-%d.log", time.Now().Format("20060102-150405.000000000"), os.Getpid())
	return os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
}

func run(args []string, output io.Writer) error {
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
	workspace, dataDir, err := resolveDirectories(options)
	if err != nil {
		return err
	}
	if options.check {
		return json.NewEncoder(output).Encode(struct {
			Version   string `json:"version"`
			Runtime   string `json:"runtime"`
			Workspace string `json:"workspace"`
			DataDir   string `json:"data_dir"`
			Browser   bool   `json:"browser_required"`
			Listener  bool   `json:"http_listener"`
		}{buildVersion, "win32", workspace, dataDir, false, false})
	}
	file, err := openDesktopLog(dataDir)
	if err != nil {
		return err
	}
	defer file.Close()
	logger := log.New(file, "SwypikOS ", log.LstdFlags|log.Lmicroseconds)
	logger.Printf("Starting native Windows desktop build=%s arch=%s", buildVersion, runtime.GOARCH)
	if err := os.MkdirAll(workspace, 0700); err != nil {
		logger.Printf("Workspace unavailable: %v", err)
		return err
	}
	// Resolve configuration before starting any worker. Writable state must never
	// depend on Explorer's current directory or be placed beside an installed EXE.
	cfg := config.Load()
	cfg.WorkspaceDir = workspace
	// Legacy relative file operations must resolve inside the selected workspace,
	// not the directory inherited from Explorer or the launcher.
	if err := os.Chdir(workspace); err != nil {
		logger.Printf("Cannot select workspace: %v", err)
		return fmt.Errorf("select workspace: %w", err)
	}
	if err := os.Setenv("SWYPIK_STATE_DIR", dataDir); err != nil {
		return err
	}
	index, err := search.Open(filepath.Join(dataDir, "search-index.json"))
	if err != nil {
		logger.Printf("Search index unavailable: %v", err)
		return fmt.Errorf("open search index: %w", err)
	}
	i := ilaria.NewEngine()
	i.SetBackend(ilaria.NewCloudBackend(options.ilariaURL, os.Getenv("ILARIA_API_TOKEN")))
	// Inventory only: launching the desktop is not consent to run compute jobs.
	s := swarm.NewDaemon(swarm.SwarmConfig{Enabled: false, TrainingEnabled: false})
	defer s.Stop()
	state := views.NewDesktopState()
	state.SetExecutionLog("Native Windows desktop ready. Swarm compute is OFF. No browser or HTTP server is running.\nUse search <query> for the local index. AI requires a configured Ilaria service. Legacy app panels remain prototypes.")
	app := engine.NewShellApp(state, i, s, index, notifications.NewBroker(), coder.NewEngine())
	app.SetLifecycleReporter(func(stage string) { logger.Print(stage) })
	if err := app.Run(); err != nil {
		logger.Printf("Native desktop failed: %v", err)
		return err
	}
	logger.Print("Native desktop closed cleanly")
	return nil
}

func main() {
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
