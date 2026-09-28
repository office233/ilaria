//go:build windows

package engine

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"swypik-os/ui/views"
)

// Only the UI thread calls start/stop. Workers update synchronized model state,
// never HWNDs or GDI objects. At most one command is active per desktop.
type nativeCommandState struct {
	busy   atomic.Bool
	cancel context.CancelFunc
}

func (s *nativeCommandState) start(task func(context.Context), failed func(error)) bool {
	if !s.busy.CompareAndSwap(false, true) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	s.cancel = cancel
	go func() {
		defer s.busy.Store(false)
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				failed(fmt.Errorf("command failed: %v", r))
			}
		}()
		task(ctx)
	}()
	return true
}

func (s *nativeCommandState) stop() {
	if s.cancel != nil {
		s.cancel()
	}
}

type nativeState struct {
	commands    nativeCommandState
	input       utf16Input
	searchQuery atomic.Value
	lifecycle   func(string)
}

// SetLifecycleReporter must be called before Run. Reports contain lifecycle
// stages only, not prompts, credentials or filesystem contents.
func (app *ShellApp) SetLifecycleReporter(reporter func(string)) {
	app.native.lifecycle = reporter
}

func (app *ShellApp) reportLifecycle(stage string) {
	if app.native.lifecycle != nil {
		app.native.lifecycle(stage)
	}
}

func (s *nativeState) query() string {
	if value := s.searchQuery.Load(); value != nil {
		return value.(string)
	}
	return ""
}

func (app *ShellApp) executeOmnibar() {
	cmd := strings.TrimSpace(app.state.GetOmnibarInput())
	if cmd == "" {
		return
	}
	// Stop requests must bypass the single-command gate even during a long task.
	lower := strings.ToLower(cmd)
	if lower == "stop" || lower == "estop" || strings.Contains(lower, "emergency stop") || strings.Contains(lower, "oprire de urgenta") {
		app.state.ClearInput()
		app.native.commands.stop()
		message := "Software stop requested; active command cancellation signalled. Physical hardware stop is not verified."
		if app.cyberOrch != nil {
			result := app.cyberOrch.TriggerEStop()
			message += "\nController: " + result.FeedbackMessage
		}
		app.state.SetExecutionLog(message)
		return
	}
	if strings.EqualFold(cmd, "cancel") {
		app.state.ClearInput()
		app.native.commands.stop()
		app.state.SetExecutionLog("Cancellation requested for the current command.")
		return
	}
	if app.native.commands.busy.Load() {
		app.state.SetExecutionLog("A command is still running. Type cancel to interrupt it; your input was retained.")
		return
	}
	app.state.ClearInput()
	app.state.SetExecutionLog("Running... The native window remains responsive. Type cancel to interrupt.")
	app.native.commands.start(func(ctx context.Context) {
		lower := strings.ToLower(cmd)
		if lower == "help" {
			app.state.SetExecutionLog("search <query>: query only your local persistent index\ncancel: interrupt the active command\nOther prompts: Ilaria inference (requires an explicitly configured service)\nLegacy panels and hardware/finance demonstrations are prototypes, not live services.")
			return
		}
		if lower == "search" || strings.HasPrefix(lower, "search ") {
			query := strings.TrimSpace(cmd[len("search"):])
			result, err := app.searchEngine.Search(query)
			if err != nil {
				app.state.SetExecutionLog("[SEARCH ERROR] " + err.Error())
				return
			}
			app.native.searchQuery.Store(query)
			app.state.SetActiveApp(views.AppSearch)
			var text strings.Builder
			fmt.Fprintf(&text, "LOCAL INDEX | %d documents | %d results for %q\n", result.IndexedDocuments, len(result.Sources), query)
			if len(result.Sources) == 0 {
				text.WriteString("No matching indexed documents. No external provider or fabricated result was used.")
			}
			for i, source := range result.Sources {
				fmt.Fprintf(&text, "%d. %s\n%s\n", i+1, source.Title, source.URL)
			}
			app.state.SetExecutionLog(text.String())
			return
		}
		app.executeLegacyCommand(ctx, cmd)
	}, func(err error) { app.state.SetExecutionLog("[ERROR] " + err.Error()) })
}
