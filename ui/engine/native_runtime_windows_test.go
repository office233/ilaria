//go:build windows

package engine

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"swypik-os/core/search"
	"swypik-os/ui/views"
)

func TestNativeMessageOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name         string
		value        uintptr
		quit, failed bool
	}{
		{"message", 1, false, false}, {"quit", 0, true, false},
		{"error32", uintptr(0xffffffff), false, true}, {"error64", ^uintptr(0), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quit, err := nativeMessageResult(tc.value, errors.New("test syscall failure"))
			if quit != tc.quit || (err != nil) != tc.failed {
				t.Fatalf("got quit=%v err=%v", quit, err)
			}
		})
	}
}

func TestNativeUTF16Input(t *testing.T) {
	for _, text := range []string{"Romanian: \u0103\u00e2\u00ee\u0219\u021b", "A\U0001f60aB", "\U0001f680\U0001f600"} {
		var decoder utf16Input
		var decoded strings.Builder
		for _, unit := range utf16.Encode([]rune(text)) {
			decoded.WriteString(decoder.push(unit))
		}
		if decoded.String() != text || !utf8.ValidString(decoded.String()) {
			t.Fatalf("corrupt text: %q -> %q", text, decoded.String())
		}
	}
	for _, tc := range []struct {
		units []uint16
		want  string
	}{
		{[]uint16{0xdc00}, "\ufffd"}, {[]uint16{0xd800, 'a'}, "\ufffda"},
		{[]uint16{0xd800, 0xd83d, 0xde00}, "\ufffd\U0001f600"},
	} {
		var decoder utf16Input
		var actual strings.Builder
		for _, unit := range tc.units {
			actual.WriteString(decoder.push(unit))
		}
		if actual.String() != tc.want {
			t.Fatalf("invalid sequence: got %q want %q", actual.String(), tc.want)
		}
	}
}

func awaitIdle(t *testing.T, commands *nativeCommandState) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for commands.busy.Load() {
		if time.Now().After(deadline) {
			t.Fatal("native command did not complete")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestNativeCommandCancellationAndSerialization(t *testing.T) {
	var commands nativeCommandState
	started := make(chan struct{})
	finished := make(chan struct{})
	failures := make(chan error, 1)
	if !commands.start(func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(finished)
	}, func(err error) { failures <- err }) {
		t.Fatal("first command rejected")
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("command did not start")
	}
	if commands.start(func(context.Context) { failures <- errors.New("overlapping command executed") }, func(err error) { failures <- err }) {
		t.Fatal("overlapping command accepted")
	}
	commands.stop()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not reach command")
	}
	awaitIdle(t, &commands)
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
}

func TestNativeStopBypassesBusyCommand(t *testing.T) {
	for _, command := range []string{"stop", "estop", "emergency stop"} {
		t.Run(command, func(t *testing.T) {
			app := &ShellApp{state: views.NewDesktopState()}
			started := make(chan struct{})
			finished := make(chan struct{})
			failures := make(chan error, 1)
			app.native.commands.start(func(ctx context.Context) {
				close(started)
				<-ctx.Done()
				close(finished)
			}, func(err error) { failures <- err })
			defer app.native.commands.stop()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("worker did not start")
			}
			for _, r := range command {
				app.state.AppendInput(r)
			}
			app.executeOmnibar()
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("busy command blocked stop request")
			}
			awaitIdle(t, &app.native.commands)
			if !strings.Contains(app.state.GetExecutionLog(), "Software stop requested") || app.state.GetOmnibarInput() != "" {
				t.Fatalf("stop was not handled immediately: %s", app.state.GetExecutionLog())
			}
			select {
			case err := <-failures:
				t.Fatal(err)
			default:
			}
		})
	}
}

func TestNativeCommandPanicDoesNotKillWindow(t *testing.T) {
	var commands nativeCommandState
	failures := make(chan error, 1)
	commands.start(func(context.Context) { panic("test panic") }, func(err error) { failures <- err })
	select {
	case err := <-failures:
		if !strings.Contains(err.Error(), "test panic") {
			t.Fatalf("lost error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("panic was not reported")
	}
	awaitIdle(t, &commands)
}

func TestNativeSearchUsesLocalIndexWithoutIlaria(t *testing.T) {
	index := search.NewEngine()
	if err := index.Upsert(search.Document{URL: "https://example.org/native", Title: "Native unicorn", Text: "Local unicorn documentation"}); err != nil {
		t.Fatal(err)
	}
	// A nil Ilaria engine ensures this command cannot quietly use inference.
	app := &ShellApp{state: views.NewDesktopState(), searchEngine: index}
	for _, r := range "search unicorn" {
		app.state.AppendInput(r)
	}
	app.executeOmnibar()
	awaitIdle(t, &app.native.commands)
	log := app.state.GetExecutionLog()
	if !strings.Contains(log, "Native unicorn") || !strings.Contains(log, "https://example.org/native") || app.native.query() != "unicorn" {
		t.Fatalf("local result missing: %s", log)
	}
	if app.state.GetOmnibarInput() != "" {
		t.Fatal("accepted input was not consumed")
	}
}

func TestNativeEmptySearchDoesNotInventResults(t *testing.T) {
	app := &ShellApp{state: views.NewDesktopState(), searchEngine: search.NewEngine()}
	for _, r := range "search absent" {
		app.state.AppendInput(r)
	}
	app.executeOmnibar()
	awaitIdle(t, &app.native.commands)
	if !strings.Contains(app.state.GetExecutionLog(), "No matching indexed documents") {
		t.Fatalf("incorrect empty-index result: %s", app.state.GetExecutionLog())
	}
}
