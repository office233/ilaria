package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"swypik-os/config"
	"swypik-os/core/coder"
	"swypik-os/core/ilaria"
	"swypik-os/core/notifications"
	"swypik-os/core/search"
	"swypik-os/core/swarm"
	"swypik-os/ui/engine"
	"swypik-os/ui/views"
	"swypik-os/ui/web"
)

func main() {
	// 0. Load Configuration from .env & Environment Variables
	cfg := config.Load()

	useGDI := flag.Bool("gdi", false, "Use legacy Win32 GDI fallback window instead of hardware GPU web engine")
	headless := flag.Bool("headless", false, "Run in background daemon mode without launching desktop window")
	port := flag.Int("port", cfg.ServerPort, "Port for sovereign web engine")
	ilariaURL := flag.String("ilaria-url", "http://127.0.0.1:8091", "Local or authenticated HTTPS Ilaria service")
	flag.Parse()

	fmt.Println("==========================================================")
	fmt.Println("   SWYPIKOS — SOVEREIGN NATIVE OPERATING SYSTEM v2026.1   ")
	fmt.Println("   Windows Desktop Shell • Embedded Web UI   ")
	fmt.Println("==========================================================")

	if *port < 0 || *port > 65535 {
		fmt.Fprintln(os.Stderr, "Port must be between 0 and 65535")
		os.Exit(1)
	}

	// 1. Initialize In-Memory Cognitive Subsystems
	fmt.Print("[1/4] Initializing Ilaria Neural Engine...")
	ilariaEngine := ilaria.NewEngine()
	ilariaEngine.SetBackend(ilaria.NewCloudBackend(*ilariaURL, os.Getenv("ILARIA_API_TOKEN")))
	fmt.Println(" OK")

	fmt.Print("[2/4] Initializing Swarm Distributed Compute Daemon...")
	swarmDaemon := swarm.NewDaemon()
	defer swarmDaemon.Stop()
	fmt.Println(" OK")

	fmt.Print("[3/4] Initializing Sovereign Search & Coder Engine...")
	searchEngine := search.NewEngine()
	notifBroker := notifications.NewBroker()
	coderEngine := coder.NewEngine()
	fmt.Println(" OK")

	// Check if legacy Win32 GDI fallback was explicitly requested
	if *useGDI {
		fmt.Print("[4/4] Launching Legacy Win32 GDI Compositor (Fallback)...")
		desktopState := views.NewDesktopState()
		app := engine.NewShellApp(desktopState, ilariaEngine, swarmDaemon, searchEngine, notifBroker, coderEngine)
		fmt.Println(" READY")

		if err := app.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "[CRITICAL ERROR] Native window failure: %v\n", err)
			swarmDaemon.Stop()
			os.Exit(1)
		}
		return
	}

	// 2. Start Sovereign Web Engine & Direct GPU Compositor
	fmt.Printf("[4/4] Starting Sovereign Web Engine on port %d...", *port)
	webServer := web.NewServer(*port, cfg.StaticDir, ilariaEngine, swarmDaemon, coderEngine)
	srvURL, err := webServer.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, " Web engine startup error: %v\n", err)
		os.Exit(1)
	}
	defer webServer.Stop()
	fmt.Printf(" READY (%s)\n", srvURL)

	// Graceful signal listener
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigChan)

	// If headless, wait for signal
	if *headless {
		fmt.Println("[SYSTEM] Running in headless sovereign daemon mode. Press Ctrl+C to stop.")
		<-sigChan
		fmt.Println("\n[SHUTDOWN] SwypikOS daemon stopped cleanly.")
		return
	}

	// Launch the desktop in browser app mode.
	fmt.Println("[DISPLAY] Launching Hardware-Accelerated Luxury Alabaster UI...")
	cmd, err := webServer.LaunchDesktopWindow(srvURL)
	if err != nil {
		fmt.Printf("[DISPLAY] Note: %v\n[DISPLAY] Open %s in your browser to interact with SwypikOS.\n", err, srvURL)
		select {
		case <-sigChan:
		}
	} else {
		fmt.Println("[DISPLAY] Desktop browser window launched.")
		if cmd != nil {
			// Edge/Chrome may hand the app window to an existing browser and
			// immediately exit this launcher process. Its exit is not a window
			// close event; the shared desktop service must remain available.
			cmdDone := make(chan error, 1)
			go func() {
				cmdDone <- cmd.Wait()
			}()

			select {
			case <-cmdDone:
				fmt.Println("[DISPLAY] Browser launcher finished; desktop service remains active. Press Ctrl+C to stop.")
				<-sigChan
			case <-sigChan:
				// Never terminate the user's shared browser/profile on shutdown.
			}
		}
	}

	fmt.Println("\n[SHUTDOWN] SwypikOS exited cleanly.")
}
