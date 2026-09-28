//go:build windows

package engine

import (
	"math"
	"syscall"
	"unsafe"
)

// GDI+ ships with every Windows version since XP. It supplies what plain GDI
// lacks for the Swypik look: anti-aliased shapes, alpha, gradients, curves.
var (
	gdiplus = syscall.NewLazyDLL("gdiplus.dll")

	procGdiplusStartup                    = gdiplus.NewProc("GdiplusStartup")
	procGdiplusShutdown                   = gdiplus.NewProc("GdiplusShutdown")
	procGdipCreateFromHDC                 = gdiplus.NewProc("GdipCreateFromHDC")
	procGdipDeleteGraphics                = gdiplus.NewProc("GdipDeleteGraphics")
	procGdipSetSmoothingMode              = gdiplus.NewProc("GdipSetSmoothingMode")
	procGdipSetPixelOffsetMode            = gdiplus.NewProc("GdipSetPixelOffsetMode")
	procGdipTranslateWorldTransform       = gdiplus.NewProc("GdipTranslateWorldTransform")
	procGdipRotateWorldTransform          = gdiplus.NewProc("GdipRotateWorldTransform")
	procGdipCreatePath                    = gdiplus.NewProc("GdipCreatePath")
	procGdipDeletePath                    = gdiplus.NewProc("GdipDeletePath")
	procGdipStartPathFigure               = gdiplus.NewProc("GdipStartPathFigure")
	procGdipClosePathFigure               = gdiplus.NewProc("GdipClosePathFigure")
	procGdipAddPathArc                    = gdiplus.NewProc("GdipAddPathArc")
	procGdipAddPathEllipse                = gdiplus.NewProc("GdipAddPathEllipse")
	procGdipAddPathLine                   = gdiplus.NewProc("GdipAddPathLine")
	procGdipAddPathBezier                 = gdiplus.NewProc("GdipAddPathBezier")
	procGdipCreateSolidFill               = gdiplus.NewProc("GdipCreateSolidFill")
	procGdipCreateLineBrushFromRectWithAn = gdiplus.NewProc("GdipCreateLineBrushFromRectWithAngle")
	procGdipSetLinePresetBlend            = gdiplus.NewProc("GdipSetLinePresetBlend")
	procGdipCreatePathGradientFromPath    = gdiplus.NewProc("GdipCreatePathGradientFromPath")
	procGdipSetPathGradientCenterColor    = gdiplus.NewProc("GdipSetPathGradientCenterColor")
	procGdipSetPathGradientSurroundCols   = gdiplus.NewProc("GdipSetPathGradientSurroundColorsWithCount")
	procGdipSetPathGradientPresetBlend    = gdiplus.NewProc("GdipSetPathGradientPresetBlend")
	procGdipDeleteBrush                   = gdiplus.NewProc("GdipDeleteBrush")
	procGdipCreatePen1                    = gdiplus.NewProc("GdipCreatePen1")
	procGdipSetPenLineCap197819           = gdiplus.NewProc("GdipSetPenLineCap197819")
	procGdipSetPenLineJoin                = gdiplus.NewProc("GdipSetPenLineJoin")
	procGdipDeletePen                     = gdiplus.NewProc("GdipDeletePen")
	procGdipFillPath                      = gdiplus.NewProc("GdipFillPath")
	procGdipCreateBitmapFromScan0         = gdiplus.NewProc("GdipCreateBitmapFromScan0")
	procGdipGetImageGraphicsContext       = gdiplus.NewProc("GdipGetImageGraphicsContext")
	procGdipDisposeImage                  = gdiplus.NewProc("GdipDisposeImage")
	procGdipResetWorldTransform           = gdiplus.NewProc("GdipResetWorldTransform")
	procGdipScaleWorldTransform           = gdiplus.NewProc("GdipScaleWorldTransform")
	procGdipSaveGraphics                  = gdiplus.NewProc("GdipSaveGraphics")
	procGdipRestoreGraphics               = gdiplus.NewProc("GdipRestoreGraphics")
	procGdiFlush                          = syscall.NewLazyDLL("gdi32.dll").NewProc("GdiFlush")
	procGdipDrawPath                      = gdiplus.NewProc("GdipDrawPath")
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
// arguments into XMM registers, and stack slots are read as 32-bit floats.
func f32(v float32) uintptr { return uintptr(math.Float32bits(v)) }

// argb builds a GDI+ colour from 0xRRGGBB and an alpha 0..255.
func argb(rgb uint32, alpha uint8) uintptr { return uintptr(uint32(alpha)<<24 | rgb&0xFFFFFF) }

// hexa builds a GDI+ colour from CSS-style 0xRRGGBBAA.
func hexa(rgba uint32) uintptr { return argb(rgba>>8, uint8(rgba)) }

// canvas draws anti-aliased shapes onto a GDI device context. When the DC's
// DIB is bound as a frame surface (bindSurface), all shapes share one GDI+
// Graphics that writes straight into the DIB memory; GDI text drawn on the
// same DC lands in the same pixels. Otherwise a Graphics is created per call.
type canvas struct{ hdc uintptr }

type surface struct {
	hdc, bitmap, g uintptr
}

// surfaces maps a DC to its bound GDI+ surface. Only the UI thread draws.
var surfaces = map[uintptr]surface{}

// bindSurface wraps a top-down 32-bit DIB (bits) of size w x h for GDI+.
func bindSurface(hdc, bits uintptr, w, h int32) func() {
	var bmp, g uintptr
	procGdipCreateBitmapFromScan0.Call(uintptr(w), uintptr(h), uintptr(w*4), 0x22009, bits, uintptr(unsafe.Pointer(&bmp))) // PixelFormat32bppRGB
	if bmp == 0 {
		return func() {}
	}
	procGdipGetImageGraphicsContext.Call(bmp, uintptr(unsafe.Pointer(&g)))
	if g == 0 {
		procGdipDisposeImage.Call(bmp)
		return func() {}
	}
	procGdipSetSmoothingMode.Call(g, 4)   // anti-alias
	procGdipSetPixelOffsetMode.Call(g, 4) // half-pixel accurate edges
	surfaces[hdc] = surface{hdc, bmp, g}
	return func() {
		delete(surfaces, hdc)
		procGdipDeleteGraphics.Call(g)
		procGdipDisposeImage.Call(bmp)
	}
}

// with runs fn with a Graphics for this canvas.
func (c canvas) with(fn func(g uintptr)) {
	if s, ok := surfaces[c.hdc]; ok {
		procGdiFlush.Call() // finish pending GDI text before GDI+ touches the pixels
		fn(s.g)
		return
	}
	var g uintptr
	procGdipCreateFromHDC.Call(c.hdc, uintptr(unsafe.Pointer(&g)))
	if g == 0 {
		return
	}
	procGdipSetSmoothingMode.Call(g, 4)
	procGdipSetPixelOffsetMode.Call(g, 4)
	fn(g)
	procGdipDeleteGraphics.Call(g)
}

type frect struct{ X, Y, W, H float32 }

func toF(r rect) frect {
	return frect{float32(r.Left), float32(r.Top), float32(r.width()), float32(r.height())}
}

func newPath() uintptr {
	var p uintptr
	procGdipCreatePath.Call(0, uintptr(unsafe.Pointer(&p)))
	return p
}

func roundPathF(r frect, radius float32) uintptr {
	p := newPath()
	d := 2 * radius
	if d > r.W {
		d = r.W
	}
	if d > r.H {
		d = r.H
	}
	if d < 0.5 {
		procGdipAddPathLine.Call(p, f32(r.X), f32(r.Y), f32(r.X+r.W), f32(r.Y))
		procGdipAddPathLine.Call(p, f32(r.X+r.W), f32(r.Y), f32(r.X+r.W), f32(r.Y+r.H))
		procGdipAddPathLine.Call(p, f32(r.X+r.W), f32(r.Y+r.H), f32(r.X), f32(r.Y+r.H))
		procGdipClosePathFigure.Call(p)
		return p
	}
	procGdipAddPathArc.Call(p, f32(r.X), f32(r.Y), f32(d), f32(d), f32(180), f32(90))
	procGdipAddPathArc.Call(p, f32(r.X+r.W-d), f32(r.Y), f32(d), f32(d), f32(270), f32(90))
	procGdipAddPathArc.Call(p, f32(r.X+r.W-d), f32(r.Y+r.H-d), f32(d), f32(d), f32(0), f32(90))
	procGdipAddPathArc.Call(p, f32(r.X), f32(r.Y+r.H-d), f32(d), f32(d), f32(90), f32(90))
	procGdipClosePathFigure.Call(p)
	return p
}

func (c canvas) fillPath(path, brush uintptr) {
	c.with(func(g uintptr) { procGdipFillPath.Call(g, brush, path) })
}

func (c canvas) strokePath(path uintptr, color uintptr, width float32) {
	var pen uintptr
	procGdipCreatePen1.Call(color, f32(width), 2, uintptr(unsafe.Pointer(&pen))) // UnitPixel
	procGdipSetPenLineCap197819.Call(pen, 2, 2, 2)                               // round caps
	procGdipSetPenLineJoin.Call(pen, 2)                                          // round joins
	c.with(func(g uintptr) { procGdipDrawPath.Call(g, pen, path) })
	procGdipDeletePen.Call(pen)
}

func solid(color uintptr) uintptr {
	var b uintptr
	procGdipCreateSolidFill.Call(color, uintptr(unsafe.Pointer(&b)))
	return b
}

// round fills a rounded rectangle with a solid ARGB colour.
func (c canvas) round(r rect, radius int32, color uintptr) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	b := solid(color)
	p := roundPathF(toF(r), float32(radius))
	c.fillPath(p, b)
	procGdipDeletePath.Call(p)
	procGdipDeleteBrush.Call(b)
}

// stroke outlines a rounded rectangle; the line sits inside the box like a
// CSS border.
func (c canvas) stroke(r rect, radius int32, color uintptr, width float32) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	f := toF(r)
	f.X, f.Y, f.W, f.H = f.X+width/2, f.Y+width/2, f.W-width, f.H-width
	p := roundPathF(f, float32(radius)-width/2)
	c.strokePath(p, color, width)
	procGdipDeletePath.Call(p)
}

// gradient fills with a CSS linear-gradient: cssAngle in degrees (180 = top
// to bottom) and colour stops at positions 0..1.
func (c canvas) gradient(r rect, radius int32, cssAngle float32, colors []uintptr, stops []float32) {
	if r.width() <= 0 || r.height() <= 0 {
		return
	}
	f := toF(r)
	var b uintptr
	procGdipCreateLineBrushFromRectWithAn.Call(uintptr(unsafe.Pointer(&f)), colors[0], colors[len(colors)-1], f32(cssAngle-90), 1, 0, uintptr(unsafe.Pointer(&b)))
	if b == 0 {
		c.round(r, radius, colors[0])
		return
	}
	if len(colors) > 2 {
		cols := make([]uint32, len(colors))
		for i, v := range colors {
			cols[i] = uint32(v)
		}
		procGdipSetLinePresetBlend.Call(b, uintptr(unsafe.Pointer(&cols[0])), uintptr(unsafe.Pointer(&stops[0])), uintptr(len(cols)))
	}
	p := roundPathF(f, float32(radius))
	c.fillPath(p, b)
	procGdipDeletePath.Call(p)
	procGdipDeleteBrush.Call(b)
}

// grad2 is a two-stop CSS gradient.
func (c canvas) grad2(r rect, radius int32, cssAngle float32, from, to uintptr) {
	c.gradient(r, radius, cssAngle, []uintptr{from, to}, []float32{0, 1})
}

// ambient paints a CSS radial-gradient(ellipse, color, transparent 70%) that
// is additionally blurred: the colour fades smoothly from the centre.
func (c canvas) ambient(r rect, rgb uint32, alpha uint8) {
	p := newPath()
	procGdipAddPathEllipse.Call(p, f32(float32(r.Left)), f32(float32(r.Top)), f32(float32(r.width())), f32(float32(r.height())))
	var b uintptr
	procGdipCreatePathGradientFromPath.Call(p, uintptr(unsafe.Pointer(&b)))
	if b != 0 {
		// Preset blend positions run from the edge (0) to the centre (1).
		cols := []uint32{uint32(argb(rgb, 0)), uint32(argb(rgb, alpha/5)), uint32(argb(rgb, alpha*3/5)), uint32(argb(rgb, alpha))}
		pos := []float32{0, 0.3, 0.65, 1}
		procGdipSetPathGradientPresetBlend.Call(b, uintptr(unsafe.Pointer(&cols[0])), uintptr(unsafe.Pointer(&pos[0])), uintptr(len(cols)))
		c.fillPath(p, b)
		procGdipDeleteBrush.Call(b)
	}
	procGdipDeletePath.Call(p)
}

// arc draws the rotated translucent wallpaper ellipse of the Swypik canvas.
func (c canvas) arc(cx, cy, w, h, degrees float32, stroke uintptr, fillFrom, fillTo uintptr) {
	c.with(func(g uintptr) { c.arcOn(g, cx, cy, w, h, degrees, stroke, fillFrom, fillTo) })
}

func (c canvas) arcOn(g uintptr, cx, cy, w, h, degrees float32, stroke uintptr, fillFrom, fillTo uintptr) {
	var state uint32
	procGdipSaveGraphics.Call(g, uintptr(unsafe.Pointer(&state)))
	defer procGdipRestoreGraphics.Call(g, uintptr(state))
	procGdipTranslateWorldTransform.Call(g, f32(cx), f32(cy), 0)
	procGdipRotateWorldTransform.Call(g, f32(degrees), 0)
	p := newPath()
	procGdipAddPathEllipse.Call(p, f32(-w/2), f32(-h/2), f32(w), f32(h))
	f := frect{-w / 2, -h / 2, w, h}
	var b uintptr
	procGdipCreateLineBrushFromRectWithAn.Call(uintptr(unsafe.Pointer(&f)), fillFrom, fillTo, f32(170-90), 1, 0, uintptr(unsafe.Pointer(&b)))
	if b != 0 {
		procGdipFillPath.Call(g, b, p)
		procGdipDeleteBrush.Call(b)
	}
	var pen uintptr
	procGdipCreatePen1.Call(stroke, f32(1), 2, uintptr(unsafe.Pointer(&pen)))
	procGdipDrawPath.Call(g, pen, p)
	procGdipDeletePen.Call(pen)
	procGdipDeletePath.Call(p)
}

// shadow approximates CSS box-shadow: offset-y, blur and spread in pixels.
// Stacked translucent layers grow outward so the edge fades like a blur.
func (c canvas) shadow(r rect, radius, offsetY, blur, spread int32, color uintptr) {
	alpha := uint8(color >> 24)
	rgb := uint32(color) & 0xFFFFFF
	layers := blur / 3
	if layers < 3 {
		layers = 3
	}
	if layers > 6 {
		layers = 6 // visually indistinguishable from more layers, far cheaper
	}
	per := uint8(int32(alpha)/layers + 1)
	for i := layers; i >= 1; i-- {
		grow := spread + blur*i/(2*layers)
		o := rect{r.Left - grow, r.Top - grow + offsetY, r.Right + grow, r.Bottom + grow + offsetY}
		if o.width() <= 0 || o.height() <= 0 {
			continue
		}
		c.round(o, radius+grow, argb(rgb, per))
	}
}

func (c canvas) circle(r rect, color uintptr) { c.round(r, r.width()/2, color) }
