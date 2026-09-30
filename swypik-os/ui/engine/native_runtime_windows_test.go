//go:build windows

package engine

import (
	"errors"
	"strings"
	"testing"
	"time"

	"swypik-os/ui/desktop"
)

func TestNativeMessageOutcomes(t *testing.T) {
	if quit, err := nativeMessageResult(1, nil); quit || err != nil {
		t.Fatal("normal message")
	}
	if quit, err := nativeMessageResult(0, nil); !quit || err != nil {
		t.Fatal("WM_QUIT")
	}
	if _, err := nativeMessageResult(^uintptr(0), errors.New("bad")); err == nil {
		t.Fatal("-1 must be an error")
	}
}

func TestAdaptiveTimerIsQuietWhenIdle(t *testing.T) {
	app := NewShellApp(nil)
	idle := app.desiredTimerMS()
	if idle < 1000 || idle > 60000 {
		t.Fatalf("idle timer=%dms", idle)
	}
	app.view.Live = true
	if got := app.desiredTimerMS(); got != 250 {
		t.Fatalf("live timer=%dms want 250", got)
	}
	app.view.Live = false
	app.view.Prompt = &desktop.Prompt{ID: "p"}
	app.promptAt = time.Now()
	if got := app.desiredTimerMS(); got != 250 {
		t.Fatalf("approval dwell timer=%dms want 250", got)
	}
}

func TestPhoneProfileSchedulesIdleBackbufferRelease(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	app := NewShellApp(nil)
	app.backDC = 1
	app.lastPaint = time.Now()
	if !app.releaseIdleBackbuffer {
		t.Fatal("phone profile must release idle full-screen backbuffer")
	}
	if got := app.desiredTimerMS(); got < 250 || got > 2000 {
		t.Fatalf("idle backbuffer release timer=%dms", got)
	}
}

func TestPerformanceProfileKeepsBackbufferWarm(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "performance")
	app := NewShellApp(nil)
	app.backDC = 1
	app.lastPaint = time.Now()
	if app.releaseIdleBackbuffer {
		t.Fatal("performance profile unexpectedly releases idle backbuffer")
	}
}

func TestLayoutMatchesOriginalGeometry(t *testing.T) {
	inside := func(a, b rect) bool {
		return a.Left >= b.Left && a.Right <= b.Right && a.Top >= b.Top && a.Bottom <= b.Bottom
	}
	for _, dpi := range []int32{96, 144, 192} {
		s := func(v int32) int32 { return v * dpi / 96 }
		for _, size := range [][2]int32{{1280, 820}, {1920, 1040}, {1000, 700}} {
			w, h := s(size[0]), s(size[1])
			for _, in := range []layoutInput{{}, {promptH: s(180)}, {chat: chatPanel, chatH: s(200)}, {chat: chatOverlay}, {expanded: true}} {
				l := computeLayout(w, h, s, in)
				if !in.expanded && (l.capsule.Bottom > l.pills.Top || l.pills.Bottom > l.main.Top || l.capsule.width() > s(740)) {
					t.Fatalf("dpi %d %v %+v: top region %+v", dpi, size, in, l)
				}
				if l.main.Bottom > l.omni.Top || l.omni.width() > s(700) && !in.expanded && in.chat != chatOverlay {
					t.Fatalf("dpi %d %v %+v: omnibar overlaps main window", dpi, size, in)
				}
				if !inside(l.rail, l.main) || !inside(l.content, l.main) || !inside(l.view, l.content) {
					t.Fatalf("dpi %d %v %+v: main regions %+v", dpi, size, in, l)
				}
				if in.promptH > 0 && (!inside(l.prompt, l.content) || l.view.Bottom > l.prompt.Top) {
					t.Fatalf("dpi %d %v: prompt overlaps content", dpi, size)
				}
				if in.chat == chatPanel && (l.chat.Bottom > l.omni.Top || l.chat.width() != l.omni.width()) {
					t.Fatalf("dpi %d %v: chat panel must sit on the omnibar", dpi, size)
				}
				if in.chat == chatOverlay && (!inside(l.chat, l.overlay) || !inside(l.omni, l.overlay)) {
					t.Fatalf("dpi %d %v: overlay regions", dpi, size)
				}
				if l.showDeck && l.deck.Right >= l.omni.Left {
					t.Fatalf("dpi %d %v: deck overlaps omnibar", dpi, size)
				}
			}
		}
	}
}

func TestColorAndTextHelpers(t *testing.T) {
	if colorRef(0x112233) != 0x332211 {
		t.Fatalf("%x", colorRef(0x112233))
	}
	if hexa(0x11223344) != 0x44112233 {
		t.Fatalf("%x", hexa(0x11223344))
	}
	if stripNUL("a"+string(rune(0))+"b") != "a b" {
		t.Fatal("NUL must not truncate UTF-16 text")
	}
	if loword(0xFFFF) != -1 || hiword(0xFF880000) != -120 {
		t.Fatal("signed words")
	}
}

func TestSVGIconsParse(t *testing.T) {
	for _, name := range append(desktop.TabIcons[:], "brand", "up", "user", "link", "expand", "close", "alert", "file") {
		ic, ok := icons[name]
		if !ok || len(ic.shapes) == 0 {
			t.Fatalf("icon %s missing", name)
		}
		for _, ops := range ic.shapes {
			if len(ops) == 0 || ops[0].op != 'M' {
				t.Fatalf("icon %s: path must start with a move", name)
			}
			for _, o := range ops {
				for _, v := range o.pts {
					if v < -2 || v > 26 {
						t.Fatalf("icon %s: point %v outside the 24px viewBox", name, v)
					}
				}
			}
		}
	}
	// A full circle becomes cubic segments that end where they started.
	ops := parsePath(circlePath(12, 12, 9, 9))
	last := ops[len(ops)-2]
	if last.op != 'C' || abs(last.pts[4]-3) > 1e-6 || abs(last.pts[5]-12) > 1e-6 {
		t.Fatalf("circle end %+v", last)
	}
	if got := tokenizePath("m12 3 2.5 6.5L21-12h.1"); strings.Join(got, ",") != "m,12,3,2.5,6.5,L,21,-12,h,.1" {
		t.Fatalf("tokens %v", got)
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func TestMeasureAndEmbeddedFont(t *testing.T) {
	release := loadEmbeddedFonts()
	defer release()
	if f := installedFace("Plus Jakarta Sans", "Segoe UI"); f != "Plus Jakarta Sans" {
		t.Fatalf("embedded face not available: %q", f)
	}
	if f, _ := faceFor(800); !strings.Contains(f, "Plus Jakarta Sans") {
		t.Fatalf("extra-bold face %q", f)
	}
	dc, _, _ := procCreateCompatibleDC.Call(0)
	if dc == 0 {
		t.Skip("no GDI device context available")
	}
	defer procDeleteDC.Call(dc)
	app := NewShellApp(nil)
	defer app.resetFonts()
	long := strings.Repeat("cuvânt ", 200)
	wide := measure(dc, app.font(12, 400), 2000, long, wrapFlags)
	narrow := measure(dc, app.font(12, 400), 300, long, wrapFlags)
	if wide <= 0 || narrow <= wide*2 {
		t.Fatalf("wrapping not applied: wide=%d narrow=%d", wide, narrow)
	}
	b := desktop.Block{Kind: desktop.KindTool, Title: "t", Body: long}
	h1, _, _ := app.blockGeometry(dc, b, 500)
	h2, _, _ := app.blockGeometry(dc, b, 500)
	if h1 != h2 || h1 <= narrow/2 {
		t.Fatalf("cached block height %d %d", h1, h2)
	}
	_, x0, x1 := app.blockGeometry(dc, desktop.Block{Kind: desktop.KindUser, Body: "Salut"}, 1000)
	if x1 != 1000 || x0 < 280 {
		t.Fatalf("bubble %d..%d", x0, x1)
	}
}
