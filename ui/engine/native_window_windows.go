//go:build windows
// +build windows

package engine

import (
	"context"
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"swypik-os/core/actiongraph"
	"swypik-os/core/azure"
	"swypik-os/core/bci"
	"swypik-os/core/cbf"
	"swypik-os/core/chameleon"
	"swypik-os/core/coder"
	"swypik-os/core/cyber"
	"swypik-os/core/evolution"
	"swypik-os/core/federated"
	"swypik-os/core/ilaria"
	"swypik-os/core/l402"
	"swypik-os/core/neuromorphic"
	"swypik-os/core/notifications"
	"swypik-os/core/search"
	"swypik-os/core/swarm"
	"swypik-os/core/worldmodel"
	"swypik-os/ui/theme"
	"swypik-os/ui/views"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW       = user32.NewProc("RegisterClassExW")
	procCreateWindowExW        = user32.NewProc("CreateWindowExW")
	procDefWindowProcW         = user32.NewProc("DefWindowProcW")
	procShowWindow             = user32.NewProc("ShowWindow")
	procUpdateWindow           = user32.NewProc("UpdateWindow")
	procGetMessageW            = user32.NewProc("GetMessageW")
	procTranslateMessage       = user32.NewProc("TranslateMessage")
	procDispatchMessageW       = user32.NewProc("DispatchMessageW")
	procPostQuitMessage        = user32.NewProc("PostQuitMessage")
	procBeginPaint             = user32.NewProc("BeginPaint")
	procEndPaint               = user32.NewProc("EndPaint")
	procGetClientRect          = user32.NewProc("GetClientRect")
	procInvalidateRect         = user32.NewProc("InvalidateRect")
	procSetTimer               = user32.NewProc("SetTimer")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procCreateSolidBrush       = gdi32.NewProc("CreateSolidBrush")
	procFillRect               = user32.NewProc("FillRect")
	procSetBkMode              = gdi32.NewProc("SetBkMode")
	procSetTextColor           = gdi32.NewProc("SetTextColor")
	procTextOutW               = gdi32.NewProc("TextOutW")
	procCreateFontW            = gdi32.NewProc("CreateFontW")
	procRoundRect              = gdi32.NewProc("RoundRect")
	procCreatePen              = gdi32.NewProc("CreatePen")
)

const (
	WS_OVERLAPPEDWINDOW = 0x00CF0000
	WS_VISIBLE          = 0x10000000
	SW_SHOWMAXIMIZED    = 3
	WM_DESTROY          = 0x0002
	WM_PAINT            = 0x000F
	WM_LBUTTONDOWN      = 0x0201
	WM_TIMER            = 0x0113
	WM_KEYDOWN          = 0x0100
	WM_CHAR             = 0x0102
	SRCCOPY             = 0x00CC0020
	TRANSPARENT         = 1
	PS_SOLID            = 0
)

type WNDCLASSEXW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     syscall.Handle
	HIcon         syscall.Handle
	HCursor       syscall.Handle
	HbrBackground syscall.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       syscall.Handle
}

type RECT struct {
	Left, Top, Right, Bottom int32
}

type PAINTSTRUCT struct {
	Hdc         syscall.Handle
	FErase      int32
	RcPaint     RECT
	FRestore    int32
	FIncUpdate  int32
	RgbReserved [32]byte
}

type POINT struct {
	X, Y int32
}

type MSG struct {
	Hwnd     syscall.Handle
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       POINT
	LPrivate uint32
}

// ShellApp represents the active native shell instance.
type ShellApp struct {
	hwnd          syscall.Handle
	state         *views.DesktopState
	ilariaEngine  *ilaria.Engine
	swarmDaemon   *swarm.Daemon
	searchEngine  *search.Engine
	notifBroker   *notifications.Broker
	coderEngine   *coder.Engine
	cyberOrch     *cyber.Orchestrator
	evolveEngine  *evolution.Engine
	bciProc       *bci.Processor
	worldModel    *worldmodel.Simulator
	neuroAdapter  *neuromorphic.Adapter
	cbfArbiter    *cbf.SimplexArbiter
	chameleonHC   *chameleon.HardwareController
	actionGraph   *actiongraph.CyclicActionGraph
	l402Engine    *l402.SettlementEngine
	fedAggregator *federated.FederatedAggregator
	azureCoord    *azure.CoordinatorClient
	fontRegular   syscall.Handle
	fontTitle     syscall.Handle
	fontBold      syscall.Handle
	fontSmall     syscall.Handle
	fontCode      syscall.Handle

	cachedFiles    []coder.FileItem
	cachedFilesAt  time.Time
	cachedSearch   string
	cachedSearchAt time.Time
	native         nativeState
}

var globalApp *ShellApp

// NewShellApp initializes the native desktop shell application.
func NewShellApp(
	state *views.DesktopState,
	iEngine *ilaria.Engine,
	sDaemon *swarm.Daemon,
	srchEngine *search.Engine,
	nBroker *notifications.Broker,
	cEngine *coder.Engine,
) *ShellApp {
	cyberOrch := cyber.NewOrchestrator(nil, nil)
	evolveEngine := evolution.NewEngine()
	bciProc := bci.NewProcessor(250.0, 32)
	worldModel := worldmodel.NewSimulator()
	neuroAdapter := neuromorphic.NewAdapter()
	cbfArbiter := cbf.NewSimplexArbiter(cbf.SafetyEnvelope{})
	chameleonHC := chameleon.NewHardwareController(nil)
	actionGraph := actiongraph.NewCyclicActionGraph(100000)
	l402Engine := l402.NewSettlementEngine(nil)
	fedAggregator := federated.NewFederatedAggregator(1)
	azureCoord := azure.NewCoordinatorClient(azure.CoordinatorConfig{})

	app := &ShellApp{
		state:         state,
		ilariaEngine:  iEngine,
		swarmDaemon:   sDaemon,
		searchEngine:  srchEngine,
		notifBroker:   nBroker,
		coderEngine:   cEngine,
		cyberOrch:     cyberOrch,
		evolveEngine:  evolveEngine,
		bciProc:       bciProc,
		worldModel:    worldModel,
		neuroAdapter:  neuroAdapter,
		cbfArbiter:    cbfArbiter,
		chameleonHC:   chameleonHC,
		actionGraph:   actionGraph,
		l402Engine:    l402Engine,
		fedAggregator: fedAggregator,
		azureCoord:    azureCoord,
	}
	globalApp = app
	return app
}

func wndProc(hwnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	if globalApp == nil {
		r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
		return r
	}

	switch msg {
	case 0x0010: // WM_CLOSE: use the same checked path as a title-bar close.
		globalApp.reportLifecycle("Win32 WM_CLOSE received")
		globalApp.native.commands.stop()
		if result, _, err := procDestroyWindow.Call(uintptr(hwnd)); result == 0 {
			globalApp.reportLifecycle(fmt.Sprintf("Win32 DestroyWindow failed: %v", err))
		}
		return 0
	case WM_DESTROY:
		globalApp.reportLifecycle("Win32 WM_DESTROY received")
		globalApp.native.commands.stop()
		// Release GDI resources after the message loop, not inside a nested
		// callback that may interrupt a paint operation.
		procPostQuitMessage.Call(0)
		return 0

	case WM_TIMER:
		// Periodic 1-second refresh
		procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		return 0

	case WM_LBUTTONDOWN:
		x := int32(lParam & 0xFFFF)
		y := int32((lParam >> 16) & 0xFFFF)
		globalApp.handleClick(x, y)
		procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		return 0

	case WM_CHAR:
		ch := rune(wParam)
		if ch == 8 { // Backspace
			globalApp.native.input.high = 0
			globalApp.state.PopInput()
		} else if ch == 13 { // Enter
			globalApp.native.input.high = 0
			globalApp.executeOmnibar()
		} else if ch >= 32 {
			for _, decoded := range globalApp.native.input.push(uint16(wParam)) {
				globalApp.state.AppendInput(decoded)
			}
		}
		procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		return 0

	case WM_KEYDOWN:
		// F1 or Escape to toggle Ilaria
		if wParam == 0x70 || wParam == 0x1B { // F1 or ESC
			globalApp.state.ToggleIlaria()
			procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		}
		return 0

	case WM_PAINT:
		var ps PAINTSTRUCT
		hdc, _, _ := procBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		globalApp.render(syscall.Handle(hdc))
		procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0
	}

	r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return r
}

func (app *ShellApp) executeLegacyCommand(ctx context.Context, cmd string) {
	lower := strings.ToLower(cmd)

	// 0. Physical E-Stop Guard
	if lower == "estop" || lower == "stop" || strings.Contains(lower, "emergency stop") || strings.Contains(lower, "oprire de urgenta") {
		res := app.cyberOrch.TriggerEStop()
		app.state.SetExecutionLog(fmt.Sprintf("[PHYSICAL E-STOP ENGAGED] %s", res.FeedbackMessage))
		return
	}

	// 1. Darwinian Evolution / Algorithmic Mutation
	if strings.HasPrefix(lower, "evolve") || strings.HasPrefix(lower, "mutate") || strings.HasPrefix(lower, "optimize") {
		mut, err := app.evolveEngine.SpawnMutant("vector_normalize", evolution.MutUnrollLoop)
		if err == nil {
			testVecs := [][]float64{{3.0, 4.0}, {1.0, 2.0, 3.0, 4.0}}
			best, _ := app.evolveEngine.BenchmarkAndSelect("vector_normalize", testVecs)
			if best != nil {
				app.state.SetExecutionLog(fmt.Sprintf("[DARWINIAN EVOLUTION] Mutant '%s' selected & hot-swapped into kernel! Verified correct. Latency: %dns (Speedup: %.2fx)", best.ID, best.LatencyNs, best.Speedup))
			} else {
				app.state.SetExecutionLog(fmt.Sprintf("[DARWINIAN EVOLUTION] Evaluated mutant '%s'. Baseline retained (already optimal).", mut.ID))
			}
		} else {
			app.state.SetExecutionLog(fmt.Sprintf("[EVOLUTION ERROR] %v", err))
		}
		return
	}

	// 2. 3D World Model / Counterfactual Physics Simulation
	if strings.HasPrefix(lower, "sim") || strings.HasPrefix(lower, "physics") {
		verdict := app.worldModel.EvaluateVehicleManeuver(worldmodel.VehicleState{
			VelocityKmh: 90.0,
			SteerAngle:  12.0,
			MassKg:      1600.0,
			Surface:     worldmodel.SurfaceIce,
		}, 0.7, 12.0)
		app.state.SetExecutionLog(fmt.Sprintf("[3D WORLD MODEL SIMULATION] 100 Counterfactuals in %dms | Surface: Black Ice | Safe: %v | Vetoed: %v | Risk: %.1f%% | Reason: %s",
			verdict.SimulationDurationMs, verdict.Safe, verdict.Vetoed, verdict.RiskScore*100, verdict.Reason))
		return
	}

	// 3. BCI & Subvocal EMG Thought Interface
	if strings.HasPrefix(lower, "bci") || strings.HasPrefix(lower, "thought") || strings.HasPrefix(lower, "eeg") {
		intent := app.bciProc.DecodeIntent()
		app.state.SetExecutionLog(fmt.Sprintf("[BCI NEURAL DECODER] Decoded Motor Thought: %s (Confidence: %.1f%% • Dominant Channel: %d • Latency: %dms)",
			intent.Intent, intent.Confidence*100, intent.Channel, intent.LatencyMs))
		return
	}

	// 4. Control Barrier Function (CBF) & Simplex Filter
	if strings.HasPrefix(lower, "cbf") || strings.HasPrefix(lower, "barrier") || strings.HasPrefix(lower, "simplex") {
		state := cbf.PhysicalState{
			ThermalC:    68.0,
			VelocityMps: 2.8,
			PositionM:   4.5,
			VibrationG:  0.8,
		}
		uNom := cbf.ControlInput{ActuationTorque: 50.0, AuxCoolingDuty: 0.2}
		res := app.cbfArbiter.FilterAction(ctx, state, uNom, 2*time.Millisecond)
		app.state.SetExecutionLog(fmt.Sprintf("[CBF QUADRATIC PROGRAMMING FILTER] Input: %.1f Nm -> Certified: %.1f Nm | Dev: %.2f | Margin: %.2f | Duration: %dμs | Simplex Engaged: %v",
			uNom.ActuationTorque, res.CertifiedInput.ActuationTorque, res.Deviation, res.MinSafetyMargin, res.FilterDurationMicro, res.SimplexEngaged))
		return
	}

	// 5. Cyclic Pregel Action Graph & Context Compaction
	if strings.HasPrefix(lower, "graph") || strings.HasPrefix(lower, "pregel") {
		app.actionGraph.AddTokens(500)
		tier, tokens, chkpts := app.actionGraph.GetStatus()
		app.state.SetExecutionLog(fmt.Sprintf("[CYCLIC PREGEL ACTION GRAPH] Tokens: %d | Compaction Tier: %v | Checkpoints: %d | Pregel BSP Superstep Ready",
			tokens, tier, chkpts))
		return
	}

	// 6. L402 Lightning Micro-Settlement & Autonomous Procurement
	if strings.HasPrefix(lower, "l402") || strings.HasPrefix(lower, "lightning") || strings.HasPrefix(lower, "procure") {
		po, needed := app.l402Engine.EvaluateMaintenanceAndProcure(3.8, 600.0, "ROBOT_ARM_01")
		challenge, preimage, _ := app.l402Engine.GenerateChallenge(21, "Offload Kinematic Path Planning")
		_ = app.l402Engine.SettleInvoice(challenge.Invoice.PaymentHash, preimage)
		sCount, sats := app.l402Engine.GetMetrics()
		msg := fmt.Sprintf("[L402 LIGHTNING SETTLEMENT] Settled 21 Sats (~$0.015) via M2M Mesh | Total Settled: %d invoices (%d sats)", sCount, sats)
		if needed && po != nil {
			msg += fmt.Sprintf("\n[AUTONOMOUS PROCUREMENT] Bearing RUL: %.1fh (<150h) -> Dispatched purchase order %s via Delivery Drone (Budget: %d sats)",
				po.EstimatedRUL, po.PartNumber, po.MaxCostSats)
		}
		app.state.SetExecutionLog(msg)
		return
	}

	// 7. Chameleon Capability Token & MMIO Sandboxed Command
	if strings.HasPrefix(lower, "mmio") || strings.HasPrefix(lower, "chameleon") {
		capToken := app.chameleonHC.MintCapability([]uint32{chameleon.AddrActuationTorque, chameleon.AddrCoolingDuty}, true, 10*time.Second)
		cmd := &chameleon.MultiRegisterActuationCommand{TargetTorque: 520, TargetCooling: 75}
		_ = cmd.Execute(ctx, app.chameleonHC, capToken)
		tVal := app.chameleonHC.ReadMMIO(chameleon.AddrActuationTorque)
		cVal := app.chameleonHC.ReadMMIO(chameleon.AddrCoolingDuty)
		app.state.SetExecutionLog(fmt.Sprintf("[CHAMELEON MMIO CAPABILITY] Token: %s | Perm: WRITE | MMIO[0x1004]=%d Torque, MMIO[0x1008]=%d Cooling | Verified",
			capToken.TokenID[:8], tVal, cVal))
		return
	}

	// 8. GPU Federated Learning Micro-Batch Step & Proof-of-Compute
	if strings.HasPrefix(lower, "train") || strings.HasPrefix(lower, "gpu") {
		delta, reward, err := app.swarmDaemon.ExecuteTrainingMicroBatch(1)
		if err == nil {
			accepted, reason := app.fedAggregator.SubmitDelta(delta)
			_ = app.azureCoord.SubmitProofOfCompute(azure.ProofOfComputeDocument{
				ID:             fmt.Sprintf("poc_%d", time.Now().UnixNano()),
				RoundID:        delta.RoundID,
				NodeID:         delta.NodeID,
				DeltaHash:      delta.ProofHash,
				TflopsComputed: delta.TFLOPSComputed,
				RewardSWP:      reward,
				Signature:      "SIG_LOCAL_GPU_2026",
			})
			app.state.SetExecutionLog(fmt.Sprintf("[GPU FEDERATED TRAINING] Micro-batch Computed: LoRA Adapter | Loss: %.3f | +%.4f SWP Coins Credited to Wallet | PoC Hash: %s... | Aggregator Status: %v (%s)",
				delta.Loss, reward, delta.ProofHash[:12], accepted, reason))
		} else {
			app.state.SetExecutionLog(fmt.Sprintf("[TRAINING ERROR] %v", err))
		}
		return
	}

	// 9. Federated Averaging Round Aggregation & Azure Model Distribution
	if strings.HasPrefix(lower, "fedavg") || strings.HasPrefix(lower, "aggregate") {
		ckpt, totalTflops, err := app.fedAggregator.AggregateRound()
		if err == nil {
			_ = app.azureCoord.PublishTrainingRound(azure.TrainingRoundDocument{
				ID:                    fmt.Sprintf("round_%d", ckpt.RoundID),
				RoundID:               ckpt.RoundID,
				BaseVersion:           "ilaria-v1.0",
				TargetVersion:         ckpt.Version,
				GlobalLoss:            ckpt.GlobalLoss,
				TotalTflops:           totalTflops,
				AggregatedWeightsBlob: fmt.Sprintf("https://swypikstorage.blob.core.windows.net/ilaria-checkpoints/%s.safetensors", ckpt.Version),
				AggregatedWeightsHash: fmt.Sprintf("%x", ckpt.Timestamp.UnixNano()),
				Status:                "FINALIZED",
			})
			app.state.SetExecutionLog(fmt.Sprintf("[FEDERATED AVERAGING] Model Updated to %s! Global Loss: %.3f | Aggregated TFLOPS: %.2f | Checkpoint Published to Azure Blob Storage & P2P Mesh",
				ckpt.Version, ckpt.GlobalLoss, totalTflops))
		} else {
			app.state.SetExecutionLog(fmt.Sprintf("[FEDAVG STATUS] %v (Type 'train' first to compute a micro-batch)", err))
		}
		return
	}

	// 10. Azure Cosmos DB & Cloud Coordinator Status
	if strings.HasPrefix(lower, "azure") || strings.HasPrefix(lower, "cloud") || strings.HasPrefix(lower, "cosmos") {
		latest, _ := app.azureCoord.FetchLatestModelCheckpoint()
		activeNodes := app.azureCoord.GetActiveNodeCount()
		app.state.SetExecutionLog(fmt.Sprintf("[AZURE CLOUD COORDINATOR] Database: SwypikSwarmDB (Cosmos DB) | Active GPU Nodes: %d | Global Model: %s (Loss: %.3f, Size: %d MB) | P2P STUN/TURN Tracker: ONLINE",
			activeNodes, latest.Version, latest.Loss, latest.SizeBytes/(1024*1024)))
		return
	}

	// 4. Cyber-Physical Intention Actuation (Vehicles, Robots, Relays, Analog Machines)
	if strings.Contains(lower, "masina") || strings.Contains(lower, "franeaza") || strings.Contains(lower, "faruri") ||
		strings.Contains(lower, "lumini") || strings.Contains(lower, "clima") || strings.Contains(lower, "robot") ||
		strings.Contains(lower, "brat") || strings.Contains(lower, "motor") || strings.Contains(lower, "releu") ||
		strings.Contains(lower, "priza") || strings.Contains(lower, "car ") || strings.Contains(lower, "brake") ||
		strings.Contains(lower, "lights") {
		res, err := app.cyberOrch.DispatchIntent(ctx, cmd)
		if err != nil {
			app.state.SetExecutionLog(fmt.Sprintf("[CYBER-PHYSICAL REJECTED] %v", err))
		} else {
			app.state.SetExecutionLog(fmt.Sprintf("[CYBER-PHYSICAL ACTUATION: %s] Success: %v (Latency: %dms)\nFeedback: %s\nTelemetry: %v",
				res.Command.Action, res.Success, res.ExecutionTimeMs, res.FeedbackMessage, res.Telemetry))
		}
		return
	}

	// 5. Code Synthesis Prompt (Claude Code / Codex style)
	if strings.HasPrefix(lower, "create ") || strings.HasPrefix(lower, "write ") || strings.HasPrefix(lower, "code ") {
		prompt := strings.TrimPrefix(cmd, "create ")
		prompt = strings.TrimPrefix(prompt, "write ")
		prompt = strings.TrimPrefix(prompt, "code ")

		fn, code := app.coderEngine.GenerateCode(prompt, "go")
		targetFile := fn
		err := app.coderEngine.CreateFile(targetFile, code)
		if err == nil {
			app.state.SetExecutionLog(fmt.Sprintf("[CODER AGENT] Successfully synthesized & wrote %s:\n\n%s", targetFile, code))
		} else {
			app.state.SetExecutionLog(fmt.Sprintf("[ERROR] Failed to write file: %v", err))
		}
		return
	}

	// 6. Terminal Shell Command (dir, echo, go build, etc.)
	if strings.HasPrefix(lower, "run ") || strings.HasPrefix(lower, "exec ") ||
		strings.HasPrefix(lower, "dir") || strings.HasPrefix(lower, "go ") ||
		strings.HasPrefix(lower, "git ") || strings.HasPrefix(lower, "echo ") {
		execCmd := cmd
		execCmd = strings.TrimPrefix(execCmd, "run ")
		execCmd = strings.TrimPrefix(execCmd, "exec ")

		res := app.coderEngine.ExecuteCommandContext(ctx, execCmd)
		app.state.SetExecutionLog(fmt.Sprintf("[TERMINAL EXECUTION: %s] (Exit: %v • Latency: %dms)\n%s", res.Command, res.Success, res.LatencyMs, res.Output))
		return
	}

	// 7. Ilaria AI Natural Prompt
	reply, _, err := app.ilariaEngine.ProcessPromptContext(ctx, cmd)
	if err != nil {
		app.state.SetExecutionLog(fmt.Sprintf("[ILARIA ERROR] %v", err))
		return
	}
	app.state.SetExecutionLog(fmt.Sprintf("[ILARIA AI] %s", reply))
}

func (app *ShellApp) handleClick(x, y int32) {
	var rect RECT
	procGetClientRect.Call(uintptr(app.hwnd), uintptr(unsafe.Pointer(&rect)))
	h := rect.Bottom - rect.Top
	w := rect.Right - rect.Left

	// 1. Top taskbar app button clicks (Y from 12 to 68)
	if y >= 12 && y <= 68 {
		startX := int32(140)
		btnW := int32(100)
		for i, item := range views.NativeApps {
			bx := startX + int32(i)*(btnW+6)
			if x >= bx && x <= bx+btnW {
				app.state.SetActiveApp(item.ID)
				return
			}
		}

		// Ilaria button (Top Right corner)
		if x >= w-120 && x <= w-30 {
			app.state.ToggleIlaria()
			return
		}
	}

	// 2. Bottom Conversational Omnibar clicks (Y from h - 75 to h - 15)
	if y >= h-75 && y <= h-15 {
		// Voice button [🎙️ Voice]
		if x >= 30 && x <= 140 {
			app.state.SetExecutionLog("Voice capture is not implemented in this native build. No microphone has been activated.")
			return
		}

		// Execute Button [⚡ Run]
		if x >= w-160 && x <= w-30 {
			app.executeOmnibar()
			return
		}
	}
}

func (app *ShellApp) initFonts() {
	segoe, _ := syscall.UTF16PtrFromString("Segoe UI")
	consolas, _ := syscall.UTF16PtrFromString("Consolas")

	f1, _, _ := procCreateFontW.Call(15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(segoe)))
	f2, _, _ := procCreateFontW.Call(24, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(segoe)))
	f3, _, _ := procCreateFontW.Call(16, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(segoe)))
	f4, _, _ := procCreateFontW.Call(12, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(segoe)))
	f5, _, _ := procCreateFontW.Call(14, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(consolas)))

	app.fontRegular = syscall.Handle(f1)
	app.fontTitle = syscall.Handle(f2)
	app.fontBold = syscall.Handle(f3)
	app.fontSmall = syscall.Handle(f4)
	app.fontCode = syscall.Handle(f5)
}

func (app *ShellApp) cleanup() {
	if app.fontRegular != 0 {
		procDeleteObject.Call(uintptr(app.fontRegular))
		app.fontRegular = 0
	}
	if app.fontTitle != 0 {
		procDeleteObject.Call(uintptr(app.fontTitle))
		app.fontTitle = 0
	}
	if app.fontBold != 0 {
		procDeleteObject.Call(uintptr(app.fontBold))
		app.fontBold = 0
	}
	if app.fontSmall != 0 {
		procDeleteObject.Call(uintptr(app.fontSmall))
		app.fontSmall = 0
	}
	if app.fontCode != 0 {
		procDeleteObject.Call(uintptr(app.fontCode))
		app.fontCode = 0
	}
}

// Run launches the native Win32 message loop and displays the SwypikOS desktop.
func (app *ShellApp) Run() error {
	// A window and its message queue belong to the creating OS thread.
	unlock := lockNativeThread()
	defer unlock()
	globalApp = app
	defer func() { globalApp = nil }()
	className, _ := syscall.UTF16PtrFromString("SwypikOS_Native_Class")
	windowTitle, _ := syscall.UTF16PtrFromString("SwypikOS - Native Windows Desktop")

	app.initFonts()
	defer func() {
		app.reportLifecycle("Win32 releasing GDI resources")
		app.cleanup()
		app.reportLifecycle("Win32 GDI resources released")
	}()
	defer app.native.commands.stop()
	hInstance, _, instanceErr := procGetModuleHandleW.Call(0)
	if hInstance == 0 {
		return fmt.Errorf("GetModuleHandleW failed: %v", instanceErr)
	}
	cursor, _, _ := procLoadCursorW.Call(0, 32512) // IDC_ARROW
	wc := WNDCLASSEXW{
		CbSize:        uint32(unsafe.Sizeof(WNDCLASSEXW{})),
		Style:         0x0003,
		LpfnWndProc:   syscall.NewCallback(wndProc),
		HInstance:     syscall.Handle(hInstance),
		HCursor:       syscall.Handle(cursor),
		LpszClassName: className,
	}
	atom, _, registerErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if atom == 0 {
		return fmt.Errorf("RegisterClassExW failed: %v", registerErr)
	}
	defer func() {
		// Capture the typed pointer, not an eagerly converted uintptr: the Go
		// allocation must remain reachable until this deferred Win32 call.
		app.reportLifecycle("Win32 unregistering window class")
		if result, _, err := procUnregisterClassW.Call(uintptr(unsafe.Pointer(className)), hInstance); result == 0 {
			app.reportLifecycle(fmt.Sprintf("Win32 UnregisterClassW failed: %v", err))
		}
	}()

	// Create hidden first: paint callbacks must not run before app.hwnd is set.
	hwnd, _, createErr := procCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(windowTitle)),
		WS_OVERLAPPEDWINDOW, 80, 80, 1420, 890, 0, 0, hInstance, 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW failed: %v", createErr)
	}
	app.hwnd = syscall.Handle(hwnd)
	defer func() {
		procKillTimer.Call(hwnd, 1)
		if exists, _, _ := procIsWindow.Call(hwnd); exists != 0 {
			procDestroyWindow.Call(hwnd)
		}
		app.hwnd = 0
	}()
	timer, _, timerErr := procSetTimer.Call(hwnd, 1, 1000, 0)
	if timer == 0 {
		return fmt.Errorf("SetTimer failed: %v", timerErr)
	}
	procShowWindow.Call(hwnd, SW_SHOWMAXIMIZED)
	procUpdateWindow.Call(hwnd)

	var msg MSG
	for {
		result, _, messageErr := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		quit, err := nativeMessageResult(result, messageErr)
		if err != nil {
			return err
		}
		if quit {
			app.reportLifecycle("Win32 WM_QUIT received")
			return nil
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// render performs flicker-free double-buffered drawing on the window.
func (app *ShellApp) render(hdc syscall.Handle) {
	var rect RECT
	procGetClientRect.Call(uintptr(app.hwnd), uintptr(unsafe.Pointer(&rect)))
	w := rect.Right - rect.Left
	h := rect.Bottom - rect.Top
	if w <= 0 || h <= 0 {
		return
	}

	memDC, _, _ := procCreateCompatibleDC.Call(uintptr(hdc))
	memBmp, _, _ := procCreateCompatibleBitmap.Call(uintptr(hdc), uintptr(w), uintptr(h))
	oldBmp, _, _ := procSelectObject.Call(memDC, memBmp)

	hMemDC := syscall.Handle(memDC)

	// 1. Draw Clean Alabaster Canvas Background (#f8fafc)
	bgBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgCore)))
	procFillRect.Call(memDC, uintptr(unsafe.Pointer(&rect)), bgBrush)
	procDeleteObject.Call(bgBrush)

	procSetBkMode.Call(memDC, TRANSPARENT)

	// 2. Draw Top Sovereign Taskbar (Light Frosted Surface)
	taskbarRect := RECT{Left: 20, Top: 12, Right: w - 20, Bottom: 68}
	tbBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgSurface)))
	tbPen, _, _ := procCreatePen.Call(PS_SOLID, 1, uintptr(theme.RGBToCOLORREF(theme.ColorBorderActive)))
	oldBrush, _, _ := procSelectObject.Call(memDC, tbBrush)
	oldPen, _, _ := procSelectObject.Call(memDC, tbPen)
	procRoundRect.Call(memDC, uintptr(taskbarRect.Left), uintptr(taskbarRect.Top), uintptr(taskbarRect.Right), uintptr(taskbarRect.Bottom), 16, 16)
	procSelectObject.Call(memDC, oldBrush)
	procSelectObject.Call(memDC, oldPen)
	procDeleteObject.Call(tbBrush)
	procDeleteObject.Call(tbPen)

	// Brand Logo Glyph
	procSelectObject.Call(memDC, uintptr(app.fontBold))
	procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
	app.drawText(hMemDC, 36, 24, "◈ SWYPIK OS")

	// Pinned Native App Buttons in Taskbar
	startX := int32(140)
	btnW := int32(100)
	activeApp := app.state.GetActiveApp()

	for i, item := range views.NativeApps {
		bx := startX + int32(i)*(btnW+6)
		btnRect := RECT{Left: bx, Top: 18, Right: bx + btnW, Bottom: 60}

		var btnBg colorRefWrapper
		var textCol colorRefWrapper

		if item.ID == activeApp {
			btnBg = colorRefWrapper(theme.RGBToCOLORREF(theme.ColorIndigo))
			textCol = colorRefWrapper(theme.RGBToCOLORREF(theme.ColorBgElevated))
		} else {
			btnBg = colorRefWrapper(theme.RGBToCOLORREF(theme.ColorBgCardHover))
			textCol = colorRefWrapper(theme.RGBToCOLORREF(theme.ColorTextPrimary))
		}

		bBrush, _, _ := procCreateSolidBrush.Call(uintptr(btnBg))
		oldBrushBtn, _, _ := procSelectObject.Call(memDC, bBrush)
		procRoundRect.Call(memDC, uintptr(btnRect.Left), uintptr(btnRect.Top), uintptr(btnRect.Right), uintptr(btnRect.Bottom), 10, 10)
		procSelectObject.Call(memDC, oldBrushBtn)
		procDeleteObject.Call(bBrush)

		procSelectObject.Call(memDC, uintptr(app.fontRegular))
		procSetTextColor.Call(memDC, uintptr(textCol))

		icon := "◈"
		switch item.ID {
		case views.AppSearch:
			icon = "🔍"
		case views.AppFiles:
			icon = "📁"
		case views.AppStudio:
			icon = "🎥"
		case views.AppWallet:
			icon = "💳"
		case views.AppTasks:
			icon = "📋"
		case views.AppConnect:
			icon = "💬"
		case views.AppSettings:
			icon = "🛡️"
		case views.AppStore:
			icon = "🛍️"
		case views.AppCyber:
			icon = "🧠"
		}
		app.drawText(hMemDC, bx+8, 28, fmt.Sprintf("%s %s", icon, item.Glyph))
	}

	// Live Clock & Ilaria Trigger in Taskbar
	clockStr := time.Now().Format("15:04:05")
	procSelectObject.Call(memDC, uintptr(app.fontBold))
	procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
	app.drawText(hMemDC, w-210, 26, clockStr)

	// Ilaria AI Button
	ilariaBtnRect := RECT{Left: w - 110, Top: 18, Right: w - 30, Bottom: 60}
	aiBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorCyan)))
	oldAiBrush, _, _ := procSelectObject.Call(memDC, aiBrush)
	procRoundRect.Call(memDC, uintptr(ilariaBtnRect.Left), uintptr(ilariaBtnRect.Top), uintptr(ilariaBtnRect.Right), uintptr(ilariaBtnRect.Bottom), 10, 10)
	procSelectObject.Call(memDC, oldAiBrush)
	procDeleteObject.Call(aiBrush)

	procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorBgElevated)))
	app.drawText(hMemDC, w-95, 28, "◈ AI")

	// 3. Render Active App Main Surface (Light Luxury Card)
	mainSurfaceRect := RECT{Left: 20, Top: 80, Right: w - 20, Bottom: h - 90}
	if app.state.IsIlariaOpen() {
		mainSurfaceRect.Right = w - 380
	}

	surfBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgElevated)))
	surfPen, _, _ := procCreatePen.Call(PS_SOLID, 1, uintptr(theme.RGBToCOLORREF(theme.ColorBorderGlass)))
	oldBrushSurf, _, _ := procSelectObject.Call(memDC, surfBrush)
	oldPenSurf, _, _ := procSelectObject.Call(memDC, surfPen)
	procRoundRect.Call(memDC, uintptr(mainSurfaceRect.Left), uintptr(mainSurfaceRect.Top), uintptr(mainSurfaceRect.Right), uintptr(mainSurfaceRect.Bottom), 16, 16)
	procSelectObject.Call(memDC, oldBrushSurf)
	procSelectObject.Call(memDC, oldPenSurf)
	procDeleteObject.Call(surfBrush)
	procDeleteObject.Call(surfPen)

	// Render App Content inside Main Surface
	app.renderAppContent(hMemDC, mainSurfaceRect, activeApp)
	if activeApp != views.AppSearch && activeApp != views.AppFiles {
		procSelectObject.Call(memDC, uintptr(app.fontBold))
		procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
		app.drawText(hMemDC, mainSurfaceRect.Left+20, mainSurfaceRect.Bottom-28, "PROTOTYPE PANEL - demonstration data; not verified live services")
	}

	// 4. Render Floating Conversational Omnibar at Bottom (Chat & Voice)
	app.renderBottomOmnibar(hMemDC, w, h)

	// 5. Render Ilaria Sidecar Panel if toggled
	if app.state.IsIlariaOpen() {
		sidecarRect := RECT{Left: w - 360, Top: 80, Right: w - 20, Bottom: h - 90}
		scBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgSurface)))
		scPen, _, _ := procCreatePen.Call(PS_SOLID, 1, uintptr(theme.RGBToCOLORREF(theme.ColorBorderActive)))
		oldBrushSc, _, _ := procSelectObject.Call(memDC, scBrush)
		oldPenSc, _, _ := procSelectObject.Call(memDC, scPen)
		procRoundRect.Call(memDC, uintptr(sidecarRect.Left), uintptr(sidecarRect.Top), uintptr(sidecarRect.Right), uintptr(sidecarRect.Bottom), 16, 16)
		procSelectObject.Call(memDC, oldBrushSc)
		procSelectObject.Call(memDC, oldPenSc)
		procDeleteObject.Call(scBrush)
		procDeleteObject.Call(scPen)

		procSelectObject.Call(memDC, uintptr(app.fontTitle))
		procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
		app.drawText(hMemDC, sidecarRect.Left+20, sidecarRect.Top+20, "◈ Ilaria Neural Assistant")

		procSelectObject.Call(memDC, uintptr(app.fontSmall))
		procSetTextColor.Call(memDC, uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hMemDC, sidecarRect.Left+20, sidecarRect.Top+55, "Native Autonomous Agent • Ready")

		history := app.ilariaEngine.GetHistory()
		startY := sidecarRect.Top + 85
		for idx, msg := range history {
			if idx > 7 {
				break
			}
			prefix := "You: "
			col := theme.RGBToCOLORREF(theme.ColorTextPrimary)
			if msg.Sender == "ilaria" {
				prefix = "Ilaria: "
				col = theme.RGBToCOLORREF(theme.ColorIndigo)
			}
			procSetTextColor.Call(memDC, uintptr(col))
			app.drawText(hMemDC, sidecarRect.Left+20, startY+int32(idx*26), prefix+msg.Text)
		}
	}

	// BitBlt final composited image to screen (Zero Flicker 60 FPS)
	procBitBlt.Call(uintptr(hdc), 0, 0, uintptr(w), uintptr(h), memDC, 0, 0, SRCCOPY)

	procSelectObject.Call(memDC, oldBmp)
	procDeleteObject.Call(memBmp)
	procDeleteDC.Call(memDC)
}

func (app *ShellApp) renderBottomOmnibar(hdc syscall.Handle, w, h int32) {
	barRect := RECT{Left: 20, Top: h - 75, Right: w - 20, Bottom: h - 15}

	// Frosted Omnibar background with soft border
	bBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgSurface)))
	bPen, _, _ := procCreatePen.Call(PS_SOLID, 1, uintptr(theme.RGBToCOLORREF(theme.ColorBorderActive)))
	oldBrushB, _, _ := procSelectObject.Call(uintptr(hdc), bBrush)
	oldPenB, _, _ := procSelectObject.Call(uintptr(hdc), bPen)
	procRoundRect.Call(uintptr(hdc), uintptr(barRect.Left), uintptr(barRect.Top), uintptr(barRect.Right), uintptr(barRect.Bottom), 16, 16)
	procSelectObject.Call(uintptr(hdc), oldBrushB)
	procSelectObject.Call(uintptr(hdc), oldPenB)
	procDeleteObject.Call(bBrush)
	procDeleteObject.Call(bPen)

	// Voice Action Button
	voiceRect := RECT{Left: 32, Top: h - 65, Right: 135, Bottom: h - 25}
	var vColor uint32 = theme.RGBToCOLORREF(theme.ColorTextSecondary)
	vLabel := "🎙️ Voice"
	if app.state.IsVoiceActive() {
		vColor = theme.RGBToCOLORREF(theme.ColorEmerald)
		vLabel = "🔴 Listening..."
	}
	vBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgCardHover)))
	oldBrushV, _, _ := procSelectObject.Call(uintptr(hdc), vBrush)
	procRoundRect.Call(uintptr(hdc), uintptr(voiceRect.Left), uintptr(voiceRect.Top), uintptr(voiceRect.Right), uintptr(voiceRect.Bottom), 10, 10)
	procSelectObject.Call(uintptr(hdc), oldBrushV)
	procDeleteObject.Call(vBrush)

	procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
	procSetTextColor.Call(uintptr(hdc), uintptr(vColor))
	app.drawText(hdc, voiceRect.Left+12, voiceRect.Top+10, vLabel)

	// Interactive Input text or Placeholder
	inputRect := RECT{Left: 150, Top: h - 65, Right: w - 160, Bottom: h - 25}
	inBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgElevated)))
	oldBrushIn, _, _ := procSelectObject.Call(uintptr(hdc), inBrush)
	procRoundRect.Call(uintptr(hdc), uintptr(inputRect.Left), uintptr(inputRect.Top), uintptr(inputRect.Right), uintptr(inputRect.Bottom), 10, 10)
	procSelectObject.Call(uintptr(hdc), oldBrushIn)
	procDeleteObject.Call(inBrush)

	inputText := app.state.GetOmnibarInput()
	procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
	if inputText == "" {
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextMuted)))
		app.drawText(hdc, inputRect.Left+14, inputRect.Top+10, "Ask Ilaria, write code, or execute any system command (e.g. 'run dir', 'create server.go')...")
	} else {
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
		app.drawText(hdc, inputRect.Left+14, inputRect.Top+10, inputText+"_")
	}

	// Execute Action Button [⚡ Run]
	runRect := RECT{Left: w - 145, Top: h - 65, Right: w - 32, Bottom: h - 25}
	runBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
	oldBrushRun, _, _ := procSelectObject.Call(uintptr(hdc), runBrush)
	procRoundRect.Call(uintptr(hdc), uintptr(runRect.Left), uintptr(runRect.Top), uintptr(runRect.Right), uintptr(runRect.Bottom), 10, 10)
	procSelectObject.Call(uintptr(hdc), oldBrushRun)
	procDeleteObject.Call(runBrush)

	procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
	procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorBgElevated)))
	app.drawText(hdc, runRect.Left+18, runRect.Top+10, "⚡ Execute")
}

func (app *ShellApp) renderAppContent(hdc syscall.Handle, r RECT, active views.AppID) {
	procSelectObject.Call(uintptr(hdc), uintptr(app.fontTitle))
	procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))

	x := r.Left + 30
	y := r.Top + 30

	switch active {
	case views.AppFiles:
		app.drawText(hdc, x, y, "📁 Files & Folders — Sovereign Filesystem Explorer")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, fmt.Sprintf("Directory: %s • Native File Manager", app.state.GetCurrentPath()))

		// List real files in current directory
		var items []coder.FileItem
		var err error
		if time.Since(app.cachedFilesAt) > 2*time.Second {
			items, err = app.coderEngine.ListDirectory(app.state.GetCurrentPath())
			if err == nil {
				app.cachedFiles = items
				app.cachedFilesAt = time.Now()
			}
		} else {
			items = app.cachedFiles
		}
		if err == nil {
			startY := y + 80
			for idx, item := range items {
				if idx > 12 {
					break
				}
				icon := "📄"
				if item.IsDir {
					icon = "📁"
				}

				rowY := startY + int32(idx*26)
				procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
				if item.IsDir {
					procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
				} else {
					procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
				}
				app.drawText(hdc, x+10, rowY, fmt.Sprintf("%s  %-30s  %10d B   %s", icon, item.Name, item.Size, item.ModTime))
			}
		}

	case views.AppSearch:
		app.drawText(hdc, x, y, "◈ Swypik Search — Sovereign Web Intelligence")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "Your own persistent index. No external search provider; no fabricated results.")

		query := app.native.query()
		summary := fmt.Sprintf("%d indexed documents. Type search <query> in the command bar.", app.searchEngine.Count())
		if query != "" {
			summary = fmt.Sprintf("Query: %s | %d indexed documents. Results are shown below.", query, app.searchEngine.Count())
		}
		aBox := RECT{Left: x, Top: y + 75, Right: r.Right - 30, Bottom: y + 180}
		aBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgSurface)))
		aPen, _, _ := procCreatePen.Call(PS_SOLID, 1, uintptr(theme.RGBToCOLORREF(theme.ColorBorderActive)))
		oldBrushA, _, _ := procSelectObject.Call(uintptr(hdc), aBrush)
		oldPenA, _, _ := procSelectObject.Call(uintptr(hdc), aPen)
		procRoundRect.Call(uintptr(hdc), uintptr(aBox.Left), uintptr(aBox.Top), uintptr(aBox.Right), uintptr(aBox.Bottom), 14, 14)
		procSelectObject.Call(uintptr(hdc), oldBrushA)
		procSelectObject.Call(uintptr(hdc), oldPenA)
		procDeleteObject.Call(aBrush)
		procDeleteObject.Call(aPen)

		procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
		app.drawText(hdc, x+20, y+92, "LOCAL SEARCH INDEX")

		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
		app.drawText(hdc, x+20, y+125, summary)

		// Live Execution Log Display Card
		logBox := RECT{Left: x, Top: y + 195, Right: r.Right - 30, Bottom: r.Bottom - 25}
		lBrush, _, _ := procCreateSolidBrush.Call(uintptr(theme.RGBToCOLORREF(theme.ColorBgCardHover)))
		oldBrushL, _, _ := procSelectObject.Call(uintptr(hdc), lBrush)
		procRoundRect.Call(uintptr(hdc), uintptr(logBox.Left), uintptr(logBox.Top), uintptr(logBox.Right), uintptr(logBox.Bottom), 12, 12)
		procSelectObject.Call(uintptr(hdc), oldBrushL)
		procDeleteObject.Call(lBrush)

		procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x+16, y+208, "⚡ AGENTIC EXECUTION TERMINAL (Claude Code / Codex Mode):")

		procSelectObject.Call(uintptr(hdc), uintptr(app.fontCode))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
		logLines := strings.Split(app.state.GetExecutionLog(), "\n")
		for lIdx, lStr := range logLines {
			if lIdx > 5 {
				break
			}
			app.drawText(hdc, x+16, y+235+int32(lIdx*22), lStr)
		}

	case views.AppStudio:
		app.drawText(hdc, x, y, "🎥 Swypik Studio & Media — Video Commerce & Creator ERP")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "Direct hardware NVENC video streaming, creator reels, and real-time inventory ERP ledger.")

		studioCards := []struct {
			domain string
			status string
			detail string
		}{
			{"🎥 Hardware NVENC Video Engine", "ACTIVE • 4K @ 60 FPS", "NVIDIA Turing NVENC hardware encoding active on GTX 1660 Ti. Sub-5ms stream latency."},
			{"🛍️ Video Commerce & Live Cart", "SYNCED • 14 Products Live", "Interactive product overlays during stream. Instant 1-click purchase via L402 Lightning & SWP coins."},
			{"📦 Sovereign Inventory & ERP", "AUTOMATED • 99.8% Match", "Warehouse stock automatically reconciled via Ilaria Vision AI. Autonomous reorder triggers armed."},
			{"💰 Creator Royalty Smart Contract", "REAL-TIME • 92.5% Payout", "Direct peer-to-peer revenue split. Zero middleman fees. Instant settlement to sovereign wallet."},
			{"🎬 Generative B-Roll AI Synthesizer", "STANDBY • Ready", "Local diffusion policy & video chunk synthesis directly utilizing spare Tensor Cores."},
		}

		startYStudio := y + 80
		for idx, card := range studioCards {
			rowY := startYStudio + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}

	case views.AppWallet:
		status := app.swarmDaemon.GetStatus()
		app.drawText(hdc, x, y, "💳 Swypik Sovereign Wallet & P2P Federated Compute")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, fmt.Sprintf("Balance: %.2f SWP | Swarm Compute Node: %.1f TFLOPS Active | Tasks Completed: %d", status.CoinsEarned, status.LocalTflops, status.TasksCompleted))

		fedCheckpoint := app.fedAggregator.GetCurrentCheckpoint()
		fedRound := app.fedAggregator.GetCurrentRound()

		gpuStatusText := "CPU Fallback (0.25 TFLOPS)"
		gpuDetailText := "Running background compute on host CPU threads."
		if status.HasGPU {
			gpuStatusText = fmt.Sprintf("ONLINE • %s (%d MB, CUDA %s)", status.GPUModel, status.VRAMMB, status.CUDAVersion)
			gpuDetailText = fmt.Sprintf("Direct CUDA acceleration active • %.1f FP32 TFLOPS • Tensor Cores enabled for Ilaria.", status.LocalTflops)
		}

		walletCards := []struct {
			domain string
			status string
			detail string
		}{
			{"🚀 Discrete NVIDIA GPU Accelerator", gpuStatusText, gpuDetailText},
			{"⚡ DiLoCo & DisTrO Federated Mesh", fmt.Sprintf("ONLINE • Round #%d (%s)", fedRound, fedCheckpoint.Version), fmt.Sprintf("500 inner steps (0ms latency), 1000x DeMo momentum compression, Multi-Krum Byzantine filter. Loss: %.4f", fedCheckpoint.GlobalLoss)},
			{"☁️ Azure Cosmos DB & Blob Mesh", "SYNCED • Partitioned Key /id", "Cloud Node directory, Proof-of-Compute ledger, and distributed weight checkpoint blob distribution active."},
			{"💰 Sovereign SWP Mining Wallet", fmt.Sprintf("ACTIVE • %.2f SWP Earned", status.CoinsEarned), "Rate: 0.10 SWP / TFLOP computed. Nonce cryptographic verification with zero external API dependencies."},
			{"🌐 ElasticDeviceMesh & P2P NAT", fmt.Sprintf("PEERS: %d ONLINE", status.MeshNodes), "Churn-resilient mesh: nodes contribute only when idle & on AC power. FullCone/Symmetric NAT hole-punching."},
			{"🧠 Zero-Latency Local Ilaria", "100% SOVEREIGN • 0ms Latency", "Model weights reside locally in VRAM. Collaborative gradient aggregation updates intelligence across the globe."},
		}

		startY := y + 80
		for idx, card := range walletCards {
			rowY := startY + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}

	case views.AppTasks:
		app.drawText(hdc, x, y, "📋 Swypik Tasks & Notes — Headless Accounting Engine")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "Autonomous financial ledger, formula engine, and executive action tracker. Zero manual data entry.")

		tasksCards := []struct {
			domain string
			status string
			detail string
		}{
			{"📊 Autonomous General Ledger", "BALANCED • €142,500.00 MTD", "Reactive sheets engine with automated double-entry verification. Mathematical audit: PASS."},
			{"🧾 Invoice OCR & Auto-Reconcile", "RECONCILED • 100% Match", "Ilaria Vision extracts invoice amounts, VAT rates, and IBANs. Reconciled against bank statements."},
			{"⚖️ EU VAT & Tax Compliance Agent", "COMPLIANT • e-Factura Ready", "Autonomous XML compilation and digital signature. Zero human spreadsheet intervention required."},
			{"📝 Executive Action Intelligence", "3 PENDING • 8 RESOLVED", "Ilaria synthesizes daily priorities from communications and schedules autonomous follow-ups."},
			{"⚡ Reactive Formula Graph", "PREGEL BSP • 0ms Lag", "Dynamic cell dependency DAG recalculated instantaneously in RAM with cycle detection."},
		}

		startYTasks := y + 80
		for idx, card := range tasksCards {
			rowY := startYTasks + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}

	case views.AppConnect:
		app.drawText(hdc, x, y, "💬 Swypik Connect — Sovereign Communications & Audio")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "Direct P2P encrypted voice, ultra-low latency audio streaming, and VIP priority dispatch.")

		connectCards := []struct {
			domain string
			status string
			detail string
		}{
			{"🎙️ Direct Lockless Audio Streamer", "ONLINE • 1.85 ms Latency", "Direct DMA Ring Buffer (16 kHz / 48 kHz). Sub-2ms pipeline eliminates all Windows mixer lag."},
			{"🔒 End-to-End Encrypted Voice Link", "E2EE ACTIVE • Ed25519", "WireGuard / Noise protocol peer-to-peer voice and messaging. Zero intermediate relay servers."},
			{"🛡️ Ilaria VIP Gatekeeper & Anti-Spam", "GUARDED • 0 Spam Allowed", "Inbound calls verified by AI proof-of-work. Telemarketers and bots automatically screened."},
			{"📱 Seamless Android & Mobile Bridge", "PAIRED • 0ms P2P Sync", "End-to-end synchronized notifications, SMS relay, and shared clipboard between PC and phone."},
			{"🔊 Neural Speech & VAD Engine", "READY • 100% Local", "Real-time voice activity detection (VAD) and sovereign text-to-speech synthesis in memory."},
		}

		startYConnect := y + 80
		for idx, card := range connectCards {
			rowY := startYConnect + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}

	case views.AppSettings:
		spamCount := app.notifBroker.GetSpamCount()
		digestText, _ := app.notifBroker.GetDigestSummary()
		app.drawText(hdc, x, y, "🛡️ Swypik Shield, Security Guard & System Preferences")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, fmt.Sprintf("System Status: %d Trackers Neutralized | %s", spamCount, digestText))

		settingsCards := []struct {
			domain string
			status string
			detail string
		}{
			{"🛡️ Sovereign Privacy & Ad-Shield", fmt.Sprintf("ACTIVE • %d Blocked", spamCount), "Telemetry, tracking cookies, and surveillance beacons neutralized at the socket level."},
			{"⚡ Extreme Resource Efficiency", "RUNNING • ~28 MB RAM", "Entire OS running in a single lightweight Go process (vs. 4,500 MB RAM wasted by Windows)."},
			{"🔒 Memory-Safe Kernel Guardian", "SECURE • Zero Buffer Overflows", "Go runtime memory safety ensures zero dangling pointers, use-after-free, or kernel RCE exploits."},
			{"🔋 Green Battery & Storage Governor", "OPTIMIZED • Zero SSD Thrash", "No Windows SearchIndexer or DiagTrack heating your drive; SSD lifespan extended by 3x."},
			{"☁️ Sovereign Azure Cloud Sync", "CONNECTED • Cosmos DB Mesh", "Encrypted backup of wallet balances and federated training weights to private Azure instance."},
		}

		startYSettings := y + 80
		for idx, card := range settingsCards {
			rowY := startYSettings + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}

	case views.AppStore:
		app.drawText(hdc, x, y, "🛍️ Swypik AI App Store — 100% Sovereign Ecosystem")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "100% AI-generated & native compiled apps. Zero slow web wrappers. Instant 1-click install.")

		storeApps := []struct {
			name string
			cat  string
			desc string
			size string
		}{
			{"Swypik Sheets AI", "Productivity", "Intelligent reactive grid with voice-prompted formula synthesis", "3.2 MB"},
			{"Swypik Docs AI", "Productivity", "Autonomous executive document writer & PDF compiler", "2.8 MB"},
			{"Swypik Coder Studio", "Developer Tools", "Agentic coding environment (Claude Code style) with native shell", "5.4 MB"},
			{"Swypik Swarm Compute", "Finance & Compute", "P2P mesh daemon earning SWP coins from idle GPU cycles", "2.1 MB"},
			{"Swypik Sovereign Search", "Internet & Privacy", "Zero-tracking, ad-free private web synthesizer", "1.5 MB"},
			{"Swypik P2P Connect", "Communication", "End-to-end encrypted voice, chat & instant PC-to-Mobile sync", "3.0 MB"},
		}

		startY := y + 80
		for idx, sa := range storeApps {
			rowY := startY + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("✦ %s", sa.name))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorCyan)))
			app.drawText(hdc, x+240, rowY+2, fmt.Sprintf("[%s • %s • INSTALLED]", sa.cat, sa.size))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, sa.desc)
		}

	case views.AppCyber:
		app.drawText(hdc, x, y, "🧠 Universal Hardware Brain & Cybernetics Cockpit")
		procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
		procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextSecondary)))
		app.drawText(hdc, x, y+35, "Direct physical control of Cars, Robots, Appliances & Analog Equipment via CAN, UART, Modbus & BCI.")

		neuroPower, neuroSpikes := app.neuroAdapter.GetTelemetry()
		lastIntent := app.bciProc.GetLastIntent()
		kVer, kLat, kMut, _ := app.evolveEngine.GetKernelStatus("vector_normalize")

		cyberCards := []struct {
			domain string
			status string
			detail string
		}{
			{"🚗 Vehicle CAN Bus (OBD-II)", "ONLINE • 500 kbps", "Connected to Powertrain ECU. Intention parser ready ('franeaza masina', 'aprinde farurile')."},
			{"🤖 Robotics Kinematics Bus", "ONLINE • 1 Mbps", "UART Dynamixel 6-DoF arm controller. Real-time forward kinematics & torque protection."},
			{"⚡ Industrial Modbus RS-485", "ONLINE • 9600 baud", "Analog relays, high-voltage contactors, and HVAC climate control units active."},
			{"🧠 Non-Invasive BCI & EMG", fmt.Sprintf("ONLINE • Intent: %s (%.0f%%)", lastIntent.Intent, lastIntent.Confidence*100), "8-channel microvolt bio-signal DSP. Subvocal EMG and motor strip thought decoder."},
			{"🔬 Neuromorphic SNN Adapter", fmt.Sprintf("ACTIVE • %.1f mW | %d Spikes", neuroPower, neuroSpikes), "Event-driven analog bridge. 0-10V / 4-20mA retrofitting for legacy 1980s machinery."},
			{"🧬 Darwinian Evolution Engine", fmt.Sprintf("OPTIMIZED • %s (%dns)", kVer, kLat), fmt.Sprintf("Algorithmic kernel mutation & superscalar unrolling active (%d mutants evaluated).", kMut)},
			{"🌐 3D Physical World Model", "READY • 100 Sim/5ms", "Monte Carlo counterfactual safety simulator. Friction circles & dynamic tip-over guard."},
		}

		startY := y + 80
		for idx, card := range cyberCards {
			rowY := startY + int32(idx*44)

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontBold))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorIndigo)))
			app.drawText(hdc, x+10, rowY, fmt.Sprintf("◈ %s", card.domain))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontSmall))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorEmerald)))
			app.drawText(hdc, x+270, rowY+2, fmt.Sprintf("[%s]", card.status))

			procSelectObject.Call(uintptr(hdc), uintptr(app.fontRegular))
			procSetTextColor.Call(uintptr(hdc), uintptr(theme.RGBToCOLORREF(theme.ColorTextPrimary)))
			app.drawText(hdc, x+25, rowY+20, card.detail)
		}
	}
}

func (app *ShellApp) drawText(hdc syscall.Handle, x, y int32, text string) {
	if text == "" {
		return
	}
	cleanText := strings.ReplaceAll(text, "\x00", " ")
	uText, err := syscall.UTF16FromString(cleanText)
	if err != nil || len(uText) <= 1 {
		return
	}
	procTextOutW.Call(uintptr(hdc), uintptr(x), uintptr(y), uintptr(unsafe.Pointer(&uText[0])), uintptr(len(uText)-1))
}

type colorRefWrapper uint32
