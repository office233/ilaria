//go:build windows

package engine

import (
	"testing"
	"time"
	"unsafe"

	"swypik-os/ui/desktop"
)

// BenchmarkRenderHome renders the home screen into an off-screen DIB, the
// same path WM_PAINT uses, so frame cost can be profiled without a window.
func BenchmarkRenderHome(b *testing.B) {
	token, ok := startGDIPlus()
	if !ok {
		b.Skip("GDI+ unavailable")
	}
	defer stopGDIPlus(token)
	defer loadEmbeddedFonts()()
	w, h := int32(1384), int32(861)
	dc, _, _ := procCreateCompatibleDC.Call(0)
	bi := bitmapInfoHeader{Size: 40, Width: w, Height: -h, Planes: 1, BitCount: 32}
	var bits uintptr
	bmp, _, _ := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	procSelectObject.Call(dc, bmp)
	defer procDeleteDC.Call(dc)
	defer procDeleteObject.Call(bmp)
	app := NewShellApp(nil)
	defer app.resetFonts()
	tiles := []desktop.Tile{}
	for i := 0; i < 10; i++ {
		tiles = append(tiles, desktop.Tile{Title: "Aplicație", Subtitle: "Descriere", Icon: "grid", Tone: "violet", Action: "tab:1"})
	}
	v := desktop.View{Tab: desktop.TabHome, Eyebrow: "UN ECOSISTEM", Title: "Universul tău Swypik", Subtitle: "Aplicațiile tale.", Tiles: tiles, Connection: "Ilaria · local"}
	release := bindSurface(dc, bits, w, h)
	defer release()
	start := time.Now()
	app.render(dc, rect{0, 0, w, h}, v) // first frame builds the static layer
	b.ReportMetric(float64(time.Since(start).Milliseconds()), "first-ms")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		app.hits = app.hits[:0]
		app.render(dc, rect{0, 0, w, h}, v)
	}
}
