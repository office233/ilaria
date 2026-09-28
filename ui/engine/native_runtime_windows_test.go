//go:build windows

package engine

import (
	"errors"
	"strings"
	"testing"

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

func TestLayoutRegionsDoNotOverlap(t *testing.T) {
	inside := func(a, b rect) bool {
		return a.Left >= b.Left && a.Right <= b.Right && a.Top >= b.Top && a.Bottom <= b.Bottom
	}
	for _, dpi := range []int32{96, 144, 192} {
		s := func(v int32) int32 { return v * dpi / 96 }
		for _, size := range [][2]int32{{1280, 820}, {1920, 1040}, {900, 620}} {
			w, h := s(size[0]), s(size[1])
			for _, promptH := range []int32{0, s(180)} {
				l := computeLayout(w, h, s, promptH)
				if l.topbar.Bottom > l.panel.Top || l.panel.Bottom > l.omni.Top {
					t.Fatalf("dpi %d %v: vertical overlap %+v", dpi, size, l)
				}
				if !inside(l.rail, l.panel) || !inside(l.body, l.panel) || l.body.Left < l.rail.Right {
					t.Fatalf("dpi %d %v: panel regions %+v", dpi, size, l)
				}
				if promptH > 0 && (!inside(l.prompt, l.panel) || l.body.Bottom > l.prompt.Top) {
					t.Fatalf("dpi %d %v: prompt overlaps content", dpi, size)
				}
				if !inside(l.edit, l.omni) || !inside(l.send, l.omni) || l.edit.Right > l.keycap.Left || l.keycap.Right > l.send.Left {
					t.Fatalf("dpi %d %v: omnibar controls overlap", dpi, size)
				}
				if l.dock.width() > 0 && l.dock.Right > l.omni.Left {
					t.Fatalf("dpi %d %v: dock overlaps omnibar", dpi, size)
				}
			}
		}
	}
}

func TestColorAndTextHelpers(t *testing.T) {
	if colorRef(0x112233) != 0x332211 {
		t.Fatalf("%x", colorRef(0x112233))
	}
	if stripNUL("a\x00b") != "a b" {
		t.Fatal("NUL must not truncate UTF-16 text")
	}
	if loword(0xFFFF) != -1 || hiword(0xFF880000) != -120 {
		t.Fatal("signed words")
	}
}

func TestMeasureWrapsLongText(t *testing.T) {
	dc, _, _ := procCreateCompatibleDC.Call(0)
	if dc == 0 {
		t.Skip("no GDI device context available")
	}
	defer procDeleteDC.Call(dc)
	app := NewShellApp(nil)
	app.createFonts()
	defer app.deleteFonts()
	long := strings.Repeat("cuvânt ", 200)
	wide := measure(dc, app.fonts.ui, 2000, long, wrapFlags)
	narrow := measure(dc, app.fonts.ui, 300, long, wrapFlags)
	if wide <= 0 || narrow <= wide*2 {
		t.Fatalf("wrapping not applied: wide=%d narrow=%d", wide, narrow)
	}
	b := desktop.Block{Kind: desktop.KindTool, Title: "t", Body: long}
	h1, _, _ := app.blockGeometry(dc, b, 500)
	h2, _, _ := app.blockGeometry(dc, b, 500)
	if h1 != h2 || h1 <= narrow/2 {
		t.Fatalf("cached block height %d %d", h1, h2)
	}
	// User messages are right-aligned bubbles no wider than 72% of the column.
	_, x0, x1 := app.blockGeometry(dc, desktop.Block{Kind: desktop.KindUser, Body: "Salut"}, 1000)
	if x1 != 1000 || x0 < 280 {
		t.Fatalf("bubble %d..%d", x0, x1)
	}
}

func TestGlyphsAndFaces(t *testing.T) {
	for _, name := range desktop.TabIcons {
		if g, ok := glyphs[name]; !ok || []rune(g)[0] < 0xE000 {
			t.Fatalf("missing glyph for %s", name)
		}
	}
	if f := installedFace("Definitely Not A Font 42", "Segoe UI"); f != "Segoe UI" {
		t.Fatalf("fallback face %q", f)
	}
}
