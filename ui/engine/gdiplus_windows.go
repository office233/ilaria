//go:build windows

package engine

import (
	"math"
	"syscall"
	"unsafe"
)

// GDI+ ships with every Windows version since XP. It supplies what plain GDI
// lacks for a modern look: anti-aliased shapes, alpha blending, gradients.
var (
	gdiplus = syscall.NewLazyDLL("gdiplus.dll")

	procGdiplusStartup                  = gdiplus.NewProc("GdiplusStartup")
	procGdiplusShutdown                 = gdiplus.NewProc("GdiplusShutdown")
	procGdipCreateFromHDC               = gdiplus.NewProc("GdipCreateFromHDC")
	procGdipDeleteGraphics              = gdiplus.NewProc("GdipDeleteGraphics")
	procGdipSetSmoothingMode            = gdiplus.NewProc("GdipSetSmoothingMode")
	procGdipSetPixelOffsetMode          = gdiplus.NewProc("GdipSetPixelOffsetMode")
	procGdipCreatePath                  = gdiplus.NewProc("GdipCreatePath")
	procGdipDeletePath                  = gdiplus.NewProc("GdipDeletePath")
	procGdipAddPathArcI                 = gdiplus.NewProc("GdipAddPathArcI")
	procGdipAddPathEllipseI             = gdiplus.NewProc("GdipAddPathEllipseI")
	procGdipClosePathFigure             = gdiplus.NewProc("GdipClosePathFigure")
	procGdipCreateSolidFill             = gdiplus.NewProc("GdipCreateSolidFill")
	procGdipCreateLineBrushFromRectI    = gdiplus.NewProc("GdipCreateLineBrushFromRectI")
	procGdipCreatePathGradientFromPath  = gdiplus.NewProc("GdipCreatePathGradientFromPath")
	procGdipSetPathGradientCenterColor  = gdiplus.NewProc("GdipSetPathGradientCenterColor")
	procGdipSetPathGradientSurroundCols = gdiplus.NewProc("GdipSetPathGradientSurroundColorsWithCount")
	procGdipDeleteBrush                 = gdiplus.NewProc("GdipDeleteBrush")
	procGdipCreatePen1                  = gdiplus.NewProc("GdipCreatePen1")
	procGdipDeletePen                   = gdiplus.NewProc("GdipDeletePen")
	procGdipFillPath                    = gdiplus.NewProc("GdipFillPath")
	procGdipDrawPath                    = gdiplus.NewProc("GdipDrawPath")
)

type gdiplusStartupInput struct {
	Version                  uint32
	DebugEventCallback       uintptr
	SuppressBackgroundThread int32
	SuppressExternalCodecs   int32
}

// startGDIPlus must be paired with stopGDIPlus.
func startGDIPlus() (uintptr, bool) {
	var token uintptr
	in := gdiplusStartupInput{Version: 1}
	if procGdiplusStartup.Find() != nil {
		return 0, false
	}
	r, _, _ := procGdiplusStartup.Call(uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&in)), 0)
	return token, r == 0
}

func stopGDIPlus(token uintptr) {
	if token != 0 {
		procGdiplusShutdown.Call(token)
	}
}

// f32 passes a GDI+ REAL. The Go Windows call path mirrors the first four
// arguments into XMM registers and stack slots are read as 32-bit floats.
func f32(v float32) uintptr { return uintptr(math.Float32bits(v)) }

// argb builds a GDI+ colour from 0xRRGGBB and an alpha 0..255.
func argb(rgb uint32, alpha uint8) uintptr { return uintptr(uint32(alpha)<<24 | rgb&0xFFFFFF) }

// canvas draws anti-aliased shapes onto a GDI device context. GDI text may be
// drawn on the same DC between shapes: every shape uses its own short-lived
// Graphics object, so nothing is left buffered when GDI draws.
type canvas struct{ hdc uintptr }

func (c canvas) graphics() uintptr {
	var g uintptr
	procGdipCreateFromHDC.Call(c.hdc, uintptr(unsafe.Pointer(&g)))
	if g != 0 {
		procGdipSetSmoothingMode.Call(g, 4)   // anti-alias
		procGdipSetPixelOffsetMode.Call(g, 4) // half-pixel accurate edges
	}
	return g
}

func roundPath(r rect, radius int32) uintptr {
	var p uintptr
	procGdipCreatePath.Call(0, uintptr(unsafe.Pointer(&p)))
	d := 2 * radius
	if d > r.width() {
		d = r.width()
	}
	if d > r.height() {
		d = r.height()
	}
	if d < 1 {
		d = 1
	}
	x, y, w, h := uintptr(r.Left), uintptr(r.Top), r.width(), r.height()
	dd := uintptr(d)
	procGdipAddPathArcI.Call(p, x, y, dd, dd, f32(180), f32(90))
	procGdipAddPathArcI.Call(p, uintptr(r.Left+w-d), y, dd, dd, f32(270), f32(90))
	procGdipAddPathArcI.Call(p, uintptr(r.Left+w-d), uintptr(r.Top+h-d), dd, dd, f32(0), f32(90))
	procGdipAddPathArcI.Call(p, x, uintptr(r.Top+h-d), dd, dd, f32(90), f32(90))
	procGdipClosePathFigure.Call(p)
	return p
}

func (c canvas) fillPath(path, brush uintptr) {
	g := c.graphics()
	if g == 0 {
		return
	}
	procGdipFillPath.Call(g, brush, path)
	procGdipDeleteGraphics.Call(g)
}

// round fills a rounded rectangle with a solid ARGB colour.
func (c canvas) round(r rect, radius int32, color uintptr) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	var b uintptr
	procGdipCreateSolidFill.Call(color, uintptr(unsafe.Pointer(&b)))
	p := roundPath(r, radius)
	c.fillPath(p, b)
	procGdipDeletePath.Call(p)
	procGdipDeleteBrush.Call(b)
}

// stroke outlines a rounded rectangle.
func (c canvas) stroke(r rect, radius int32, color uintptr, width float32) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	var pen uintptr
	procGdipCreatePen1.Call(color, f32(width), 2, uintptr(unsafe.Pointer(&pen))) // UnitPixel
	p := roundPath(r, radius)
	if g := c.graphics(); g != 0 {
		procGdipDrawPath.Call(g, pen, p)
		procGdipDeleteGraphics.Call(g)
	}
	procGdipDeletePath.Call(p)
	procGdipDeletePen.Call(pen)
}

// gradient fills with a linear gradient; mode 0 horizontal, 1 vertical,
// 2 forward diagonal.
func (c canvas) gradient(r rect, radius int32, from, to uintptr, mode uintptr) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	gr := struct{ X, Y, W, H int32 }{r.Left, r.Top, r.width(), r.height()}
	var b uintptr
	procGdipCreateLineBrushFromRectI.Call(uintptr(unsafe.Pointer(&gr)), from, to, mode, 0, uintptr(unsafe.Pointer(&b)))
	if b == 0 {
		c.round(r, radius, from)
		return
	}
	p := roundPath(r, radius)
	c.fillPath(p, b)
	procGdipDeletePath.Call(p)
	procGdipDeleteBrush.Call(b)
}

// glow paints a soft radial light: centre colour fading to transparent.
func (c canvas) glow(r rect, rgb uint32, alpha uint8) {
	var p uintptr
	procGdipCreatePath.Call(0, uintptr(unsafe.Pointer(&p)))
	procGdipAddPathEllipseI.Call(p, uintptr(r.Left), uintptr(r.Top), uintptr(r.width()), uintptr(r.height()))
	var b uintptr
	procGdipCreatePathGradientFromPath.Call(p, uintptr(unsafe.Pointer(&b)))
	if b != 0 {
		procGdipSetPathGradientCenterColor.Call(b, argb(rgb, alpha))
		surround := uint32(argb(rgb, 0))
		count := int32(1)
		procGdipSetPathGradientSurroundCols.Call(b, uintptr(unsafe.Pointer(&surround)), uintptr(unsafe.Pointer(&count)))
		c.fillPath(p, b)
		procGdipDeleteBrush.Call(b)
	}
	procGdipDeletePath.Call(p)
}

// shadow draws a soft drop shadow below a rounded rectangle.
func (c canvas) shadow(r rect, radius, spread int32, rgb uint32, alpha uint8) {
	if spread < 1 {
		return
	}
	step := alpha / uint8(spread)
	if step == 0 {
		step = 1
	}
	for i := spread; i >= 1; i-- {
		o := rect{r.Left - i, r.Top - i + spread/2, r.Right + i, r.Bottom + i + spread/2}
		c.round(o, radius+i, argb(rgb, step))
	}
}

func (c canvas) circle(r rect, color uintptr) { c.round(r, r.width()/2, color) }
