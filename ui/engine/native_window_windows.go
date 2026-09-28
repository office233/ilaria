//go:build windows

// Package engine is the native Win32 front end of the SwypikOS desktop. It
// draws desktop.View snapshots with GDI+ (shapes) and GDI (ClearType text) and
// forwards input to the controller. No browser, WebView or HTTP server.
package engine

import (
	"fmt"
	"hash/fnv"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"swypik-os/ui/desktop"
	"swypik-os/ui/theme"
)

// ClassName is checked by scripts/smoke-windows.ps1.
const ClassName = "SwypikOS_Native_Class"

// approvalDwell is the minimum time a prompt is visible before F8 or a click
// can accept it, so input meant for something else cannot approve it.
const approvalDwell = 500 * time.Millisecond

type hitKind int

const (
	hitTab hitKind = iota
	hitAction
	hitConfirm
	hitReject
	hitSend
	hitSearchPill
)

type hit struct {
	r      rect
	kind   hitKind
	tab    desktop.Tab
	action string
}

type fontSet struct {
	ui, bold, small, smallBold, title, h2, brand, empty, mono, icon, iconLg, iconSm syscall.Handle
}

type ShellApp struct {
	ctl         *desktop.Controller
	hwnd        atomic.Uintptr // read by Notify from any goroutine
	edit        syscall.Handle
	dpi         int32
	fonts       fontSet
	faces       struct{ text, display, mono, icons string }
	editBrush   uintptr
	scroll      [desktop.TabCount]int32
	maxScroll   [desktop.TabCount]int32
	stick       [desktop.TabCount]bool
	hits        []hit
	hover       int
	promptKey   string
	promptAt    time.Time
	heights     map[uint64]int32
	view        desktop.View
	lifecycle   func(string)
	layout      layout
	placeholder string
	minute      int
}

var globalApp *ShellApp

func NewShellApp(ctl *desktop.Controller) *ShellApp {
	app := &ShellApp{ctl: ctl, hover: -1, heights: map[uint64]int32{}, dpi: 96}
	app.stick[desktop.TabChat] = true
	app.stick[desktop.TabAgent] = true
	return app
}

// SetLifecycleReporter must be called before Run. Reports contain lifecycle
// stages only, never prompts, credentials or file contents.
func (app *ShellApp) SetLifecycleReporter(reporter func(string)) { app.lifecycle = reporter }

func (app *ShellApp) report(stage string) {
	if app.lifecycle != nil {
		app.lifecycle(stage)
	}
}

// Notify requests a repaint; safe from any goroutine.
func (app *ShellApp) Notify() {
	if h := app.hwnd.Load(); h != 0 {
		procPostMessageW.Call(h, wmRepaint, 0, 0)
	}
}

func (app *ShellApp) s(v int32) int32 { return v * app.dpi / 96 }
func (app *ShellApp) handle() uintptr { return app.hwnd.Load() }
func (app *ShellApp) invalidate()     { procInvalidateRect.Call(app.handle(), 0, 0) }

// ---------------------------------------------------------------- layout

type layout struct {
	topbar, panel, rail, header, body, prompt, omni, edit, send, keycap, hint, dock rect
}

func centered(w, width int32) (int32, int32) {
	left := (w - width) / 2
	return left, left + width
}

// computeLayout is pure so it can be tested. promptH is 0 without a prompt.
func computeLayout(w, h int32, s func(int32) int32, promptH int32) layout {
	var l layout
	m := s(20)
	tw := w - 2*m
	if tw > s(760) {
		tw = s(760)
	}
	left, right := centered(w, tw)
	l.topbar = rect{left, s(14), right, s(14) + s(56)}

	ow := w - 2*m
	if ow > s(900) {
		ow = s(900)
	}
	left, right = centered(w, ow)
	omniH := s(58)
	l.omni = rect{left, h - s(30) - omniH, right, h - s(30)}
	l.hint = rect{l.omni.Left, l.omni.Bottom + s(5), l.omni.Right, h - s(4)}
	l.send = rect{l.omni.Right - s(7) - s(44), l.omni.Top + (omniH-s(44))/2, l.omni.Right - s(7), l.omni.Top + (omniH-s(44))/2 + s(44)}
	l.keycap = rect{l.send.Left - s(12) - s(58), l.omni.Top + (omniH-s(26))/2, l.send.Left - s(12), l.omni.Top + (omniH-s(26))/2 + s(26)}
	l.edit = rect{l.omni.Left + s(26), l.omni.Top + (omniH-s(24))/2, l.keycap.Left - s(16), l.omni.Top + (omniH-s(24))/2 + s(24)}
	if l.omni.Left-m >= s(250) {
		l.dock = rect{m, l.omni.Top - s(8), m + s(236), l.omni.Bottom + s(8)}
	}

	l.panel = rect{m, l.topbar.Bottom + s(14), w - m, l.omni.Top - s(16)}
	l.rail = rect{l.panel.Left, l.panel.Top, l.panel.Left + s(76), l.panel.Bottom}
	l.header = rect{l.rail.Right + s(12), l.panel.Top + s(16), l.panel.Right - s(24), l.panel.Top + s(16) + s(40)}
	l.body = rect{l.rail.Right + s(4), l.header.Bottom + s(4), l.panel.Right - s(4), l.panel.Bottom - s(10)}
	if promptH > 0 {
		l.prompt = rect{l.body.Left + s(28), l.body.Bottom - promptH, l.body.Right - s(28), l.body.Bottom}
		l.body.Bottom = l.prompt.Top - s(8)
	}
	return l
}

// ---------------------------------------------------------------- fonts

var (
	procGetTextFaceW          = gdi32.NewProc("GetTextFaceW")
	procSetTextCharacterExtra = gdi32.NewProc("SetTextCharacterExtra")
	procGetDC                 = user32.NewProc("GetDC")
	procReleaseDC             = user32.NewProc("ReleaseDC")
	dwmapi                    = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	procLoadIconW             = user32.NewProc("LoadIconW")
)

// installedFace returns the first face the system actually has, so Windows
// 11 gets Segoe UI Variable and Fluent icons while Windows 10 falls back.
func installedFace(candidates ...string) string {
	dc, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, dc)
	for _, face := range candidates {
		f, _, _ := procCreateFontW.Call(uintptr(^uint32(15)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(utf16Ptr(face))))
		old, _, _ := procSelectObject.Call(dc, f)
		buf := make([]uint16, 64)
		procGetTextFaceW.Call(dc, 64, uintptr(unsafe.Pointer(&buf[0])))
		procSelectObject.Call(dc, old)
		procDeleteObject.Call(f)
		if strings.EqualFold(syscall.UTF16ToString(buf), face) {
			return face
		}
	}
	return candidates[len(candidates)-1]
}

func (app *ShellApp) makeFont(pt float64, weight int, face string) syscall.Handle {
	height := -int32(pt*float64(app.dpi)/72 + 0.5)
	f, _, _ := procCreateFontW.Call(uintptr(height), 0, 0, 0, uintptr(weight), 0, 0, 0, 1, 0, 0, cleartypeQuality, 0, uintptr(unsafe.Pointer(utf16Ptr(face))))
	return syscall.Handle(f)
}

func (app *ShellApp) createFonts() {
	if app.faces.text == "" {
		app.faces.text = installedFace("Segoe UI Variable Text", "Segoe UI")
		app.faces.display = installedFace("Segoe UI Variable Display", "Segoe UI")
		app.faces.mono = installedFace("Cascadia Mono", "Consolas")
		app.faces.icons = installedFace("Segoe Fluent Icons", "Segoe MDL2 Assets")
	}
	app.deleteFonts()
	t, d := app.faces.text, app.faces.display
	app.fonts = fontSet{
		ui:        app.makeFont(10.5, 400, t),
		bold:      app.makeFont(10.5, 600, t),
		small:     app.makeFont(8.75, 400, t),
		smallBold: app.makeFont(8.25, 700, t),
		title:     app.makeFont(24, 700, d),
		h2:        app.makeFont(12, 600, d),
		brand:     app.makeFont(14, 700, d),
		empty:     app.makeFont(19, 400, d),
		mono:      app.makeFont(9.5, 400, app.faces.mono),
		icon:      app.makeFont(12, 400, app.faces.icons),
		iconLg:    app.makeFont(16, 400, app.faces.icons),
		iconSm:    app.makeFont(10, 400, app.faces.icons),
	}
	app.heights = map[uint64]int32{}
	if app.edit != 0 {
		procSendMessageW.Call(uintptr(app.edit), wmSetFont, uintptr(app.fonts.ui), 1)
	}
}

func (app *ShellApp) deleteFonts() {
	f := app.fonts
	for _, h := range []syscall.Handle{f.ui, f.bold, f.small, f.smallBold, f.title, f.h2, f.brand, f.empty, f.mono, f.icon, f.iconLg, f.iconSm} {
		if h != 0 {
			procDeleteObject.Call(uintptr(h))
		}
	}
	app.fonts = fontSet{}
}

// Segoe Fluent Icons / MDL2 Assets code points.
var glyphs = map[string]string{
	"home": "\uE80F", "chat": "\uE8BD", "agent": "\uE99A", "search": "\uE721", "folder": "\uE8B7",
	"chip": "\uE945", "settings": "\uE713", "refresh": "\uE72C", "globe": "\uE774", "plug": "\uE71B",
	"sparkle": "\uE734", "send": "\uE74A", "open": "\uE8A7", "person": "\uE77B", "stop": "\uE71A",
	"doc": "\uE8A5", "code": "\uE943", "error": "\uE783", "info": "\uE946", "back": "\uE72B",
	"warning": "\uE7BA", "check": "\uE8FB", "pin": "\uE718",
}

func glyph(name string) string {
	if g, ok := glyphs[name]; ok {
		return g
	}
	return glyphs["sparkle"]
}

// ---------------------------------------------------------------- text

func text(hdc uintptr, font syscall.Handle, color uint32, r rect, s string, flags uintptr) {
	if s == "" {
		return
	}
	procSelectObject.Call(hdc, uintptr(font))
	procSetTextColor.Call(hdc, colorRef(color))
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16Ptr(s))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags|dtNoPrefix)
}

const wrapFlags = dtWordBreak | dtExpandTabs | dtEditControl
const lineFlags = dtSingleLine | dtVCenter | dtEndEllipsis

// measure returns the wrapped height of s at the given width.
func measure(hdc uintptr, font syscall.Handle, width int32, s string, flags uintptr) int32 {
	_, h := measureBox(hdc, font, width, s, flags)
	return h
}

// measureBox returns the used width and height of s wrapped at width.
func measureBox(hdc uintptr, font syscall.Handle, width int32, s string, flags uintptr) (int32, int32) {
	if s == "" {
		return 0, 0
	}
	procSelectObject.Call(hdc, uintptr(font))
	r := rect{0, 0, width, 0}
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16Ptr(s))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags|dtCalcRect|dtNoPrefix)
	return r.Right, r.Bottom
}

func textWidth(hdc uintptr, font syscall.Handle, s string) int32 {
	w, _ := measureBox(hdc, font, 1<<20, s, dtSingleLine)
	return w
}

// ---------------------------------------------------------------- blocks

type blockStyle struct {
	bg, border, title, body uint32
	bodyFont                syscall.Handle
	icon                    string
	iconColor               uint32
}

func (app *ShellApp) style(b desktop.Block) blockStyle {
	st := blockStyle{bg: theme.Surface, border: theme.PanelBorder, title: theme.TextPrimary, body: theme.TextPrimary, bodyFont: app.fonts.ui}
	switch b.Kind {
	case desktop.KindUser:
		st.bg, st.border = theme.AccentSoft, theme.AccentSoft
	case desktop.KindAssistant:
		st.title = theme.Accent
	case desktop.KindInfo:
		st.bg, st.border, st.body, st.icon, st.iconColor = theme.SurfaceSoft, theme.SurfaceSoft, theme.TextSecondary, "info", theme.TextMuted
	case desktop.KindError:
		st.bg, st.border, st.title, st.body, st.icon, st.iconColor = theme.ErrorBg, theme.ErrorBorder, theme.ErrorText, theme.ErrorText, "error", theme.ErrorText
	case desktop.KindTool:
		st.bg, st.border, st.body, st.bodyFont, st.icon, st.iconColor = theme.SurfaceSoft, theme.Divider, theme.TextSecondary, app.fonts.mono, "code", theme.Accent
	case desktop.KindResult:
		st.title, st.body, st.icon, st.iconColor = theme.Accent, theme.TextSecondary, "open", theme.TextMuted
		if strings.HasPrefix(b.Action, "files:") {
			st.icon = "doc"
			if strings.HasSuffix(b.Title, "/") || b.Title == ".." || strings.HasPrefix(b.Title, "←") {
				st.icon = "folder"
			}
		}
	case desktop.KindCode:
		st.bg, st.border, st.body, st.bodyFont = theme.CodeBg, theme.CodeBg, theme.CodeText, app.fonts.mono
	}
	if b.Icon != "" {
		st.icon = b.Icon
		if b.Kind == desktop.KindTool {
			st.bodyFont = app.fonts.ui // descriptive cards, not command output
		}
	}
	return st
}

func blockTitle(b desktop.Block) string {
	if b.Kind == desktop.KindAssistant && b.Title == "" {
		return "Ilaria"
	}
	return b.Title
}

// blockGeometry lays out one block inside a column of width colW. It returns
// the block height and the card's horizontal extent relative to the column.
func (app *ShellApp) blockGeometry(hdc uintptr, b desktop.Block, colW int32) (h, x0, x1 int32) {
	pad := app.s(16)
	st := app.style(b)
	switch b.Kind {
	case desktop.KindUser:
		maxW := colW * 72 / 100
		tw, th := measureBox(hdc, app.fonts.ui, maxW-2*pad, b.Body, wrapFlags)
		return th + 2*app.s(12), colW - tw - 2*pad, colW
	case desktop.KindAssistant:
		x0 = app.s(46)
		x1 = colW
		if x1-x0 > app.s(860) {
			x1 = x0 + app.s(860)
		}
	default:
		x0, x1 = 0, colW
	}
	key := fnv.New64a()
	fmt.Fprintf(key, "%d|%d|%d|%s|%s|%s", b.Kind, x1-x0, app.dpi, b.Title, b.Body, b.Action)
	sum := key.Sum64()
	if v, ok := app.heights[sum]; ok {
		return v, x0, x1
	}
	inner := x1 - x0 - 2*pad
	if st.icon != "" {
		inner -= app.s(30)
	}
	total := 2 * pad
	if title := blockTitle(b); title != "" {
		total += measure(hdc, app.fonts.bold, inner, title, wrapFlags)
		if b.Body != "" {
			total += app.s(6)
		}
	}
	total += measure(hdc, st.bodyFont, inner, b.Body, wrapFlags)
	if len(app.heights) > 4000 {
		app.heights = map[uint64]int32{}
	}
	app.heights[sum] = total
	return total, x0, x1
}

func (app *ShellApp) drawBlock(hdc uintptr, b desktop.Block, r rect, hovered bool) {
	c := canvas{hdc}
	st := app.style(b)
	pad := app.s(16)
	if b.Kind == desktop.KindUser {
		c.round(r, app.s(18), argb(st.bg, 255))
		text(hdc, app.fonts.ui, theme.TextPrimary, rect{r.Left + pad, r.Top + app.s(12), r.Right - pad, r.Bottom}, b.Body, wrapFlags)
		return
	}
	if b.Kind == desktop.KindAssistant {
		av := rect{r.Left - app.s(46), r.Top + app.s(2), r.Left - app.s(46) + app.s(34), r.Top + app.s(2) + app.s(34)}
		c.gradient(av, app.s(17), argb(theme.AccentLight, 255), argb(theme.AccentDark, 255), 2)
		text(hdc, app.fonts.bold, theme.TextOnAccent, av, "I", dtSingleLine|dtVCenter|dtCenter)
	}
	if hovered {
		c.shadow(r, app.s(16), app.s(6), theme.Shadow, 40)
	}
	c.round(r, app.s(16), argb(st.bg, 255))
	border := st.border
	if hovered {
		border = theme.AccentLight
	}
	c.stroke(r, app.s(16), argb(border, 255), 1)
	inner := rect{r.Left + pad, r.Top + pad, r.Right - pad, r.Bottom - pad}
	if st.icon != "" {
		text(hdc, app.fonts.icon, st.iconColor, rect{inner.Left, inner.Top + app.s(1), inner.Left + app.s(22), inner.Top + app.s(22)}, glyph(st.icon), dtSingleLine)
		inner.Left += app.s(30)
	}
	if title := blockTitle(b); title != "" {
		th := measure(hdc, app.fonts.bold, inner.width(), title, wrapFlags)
		text(hdc, app.fonts.bold, st.title, rect{inner.Left, inner.Top, inner.Right, inner.Top + th}, title, wrapFlags)
		inner.Top += th + app.s(6)
	}
	text(hdc, st.bodyFont, st.body, inner, b.Body, wrapFlags)
}

// ---------------------------------------------------------------- content

type item struct {
	r      rect // relative to the content origin
	block  *desktop.Block
	tile   *desktop.Tile
	isHead bool
}

func (app *ShellApp) layoutContent(hdc uintptr, v desktop.View, colW int32) ([]item, int32) {
	var items []item
	y := int32(0)
	if v.Title != "" {
		h := app.s(20) + app.s(48)
		if v.Subtitle != "" {
			h += measure(hdc, app.fonts.ui, colW, v.Subtitle, wrapFlags)
		}
		items = append(items, item{r: rect{0, 0, colW, h}, isHead: true})
		y = h + app.s(24)
	}
	if n := len(v.Tiles); n > 0 {
		gap := app.s(16)
		cols := (colW + gap) / (app.s(196) + gap)
		if cols < 1 {
			cols = 1
		}
		if cols > 5 {
			cols = 5
		}
		tw := (colW - (cols-1)*gap) / cols
		th := app.s(118)
		for i := range v.Tiles {
			row, col := int32(i)/cols, int32(i)%cols
			x := col * (tw + gap)
			top := y + row*(th+gap)
			items = append(items, item{r: rect{x, top, x + tw, top + th}, tile: &v.Tiles[i]})
		}
		rows := (int32(n) + cols - 1) / cols
		y += rows*(th+gap) + app.s(8)
	}
	for i := range v.Blocks {
		h, x0, x1 := app.blockGeometry(hdc, v.Blocks[i], colW)
		items = append(items, item{r: rect{x0, y, x1, y + h}, block: &v.Blocks[i]})
		y += h + app.s(12)
	}
	return items, y
}

func (app *ShellApp) drawHeading(hdc uintptr, v desktop.View, r rect) {
	procSetTextCharacterExtra.Call(hdc, uintptr(app.s(2)))
	text(hdc, app.fonts.smallBold, theme.TextSecondary, rect{r.Left, r.Top, r.Right, r.Top + app.s(18)}, v.Eyebrow, dtSingleLine|dtEndEllipsis)
	procSetTextCharacterExtra.Call(hdc, 0)
	ty := r.Top + app.s(20)
	text(hdc, app.fonts.title, theme.TextPrimary, rect{r.Left, ty, r.Right, ty + app.s(46)}, v.Title, lineFlags)
	w := textWidth(hdc, app.fonts.title, v.Title)
	text(hdc, app.fonts.title, theme.Accent, rect{r.Left + w, ty, r.Right, ty + app.s(46)}, ".", lineFlags)
	if v.Subtitle != "" {
		text(hdc, app.fonts.ui, theme.TextSecondary, rect{r.Left, ty + app.s(48), r.Right, r.Bottom}, v.Subtitle, wrapFlags)
	}
}

func (app *ShellApp) drawTile(hdc uintptr, t desktop.Tile, r rect, hovered bool) {
	c := canvas{hdc}
	if hovered {
		c.shadow(r, app.s(18), app.s(8), theme.Shadow, 48)
	}
	c.round(r, app.s(18), argb(theme.Surface, 255))
	border := uint32(theme.PanelBorder)
	if hovered {
		border = theme.AccentLight
	}
	c.stroke(r, app.s(18), argb(border, 255), 1)
	tone, ok := theme.Tones[t.Tone]
	if !ok {
		tone = theme.Tones["violet"]
	}
	ic := rect{r.Left + app.s(18), r.Top + app.s(18), r.Left + app.s(18) + app.s(40), r.Top + app.s(18) + app.s(40)}
	c.round(ic, app.s(12), argb(tone.Bg, 255))
	text(hdc, app.fonts.iconLg, tone.Fg, ic, glyph(t.Icon), dtSingleLine|dtVCenter|dtCenter)
	text(hdc, app.fonts.iconSm, theme.TextMuted, rect{r.Right - app.s(34), r.Top + app.s(14), r.Right - app.s(12), r.Top + app.s(34)}, glyph("open"), dtSingleLine|dtVCenter|dtCenter)
	text(hdc, app.fonts.bold, theme.TextPrimary, rect{r.Left + app.s(18), ic.Bottom + app.s(10), r.Right - app.s(12), ic.Bottom + app.s(30)}, t.Title, lineFlags)
	text(hdc, app.fonts.small, theme.TextSecondary, rect{r.Left + app.s(18), ic.Bottom + app.s(30), r.Right - app.s(12), ic.Bottom + app.s(48)}, t.Subtitle, lineFlags)
}

// ---------------------------------------------------------------- painting

func (app *ShellApp) promptKeyOf(p *desktop.Prompt) string {
	if p == nil {
		return ""
	}
	return p.ID + "\x00" + p.Title + "\x00" + p.Body
}

func (app *ShellApp) promptReady() bool {
	return app.view.Prompt != nil && time.Since(app.promptAt) >= approvalDwell
}

func (app *ShellApp) paint(target uintptr) {
	var cr rect
	procGetClientRect.Call(app.handle(), uintptr(unsafe.Pointer(&cr)))
	w, h := cr.width(), cr.height()
	if w <= 0 || h <= 0 {
		return
	}
	memDC, _, _ := procCreateCompatibleDC.Call(target)
	bmp, _, _ := procCreateCompatibleBitmap.Call(target, uintptr(w), uintptr(h))
	if memDC == 0 || bmp == 0 {
		if bmp != 0 {
			procDeleteObject.Call(bmp)
		}
		if memDC != 0 {
			procDeleteDC.Call(memDC)
		}
		return
	}
	oldBmp, _, _ := procSelectObject.Call(memDC, bmp)
	procSetBkMode.Call(memDC, bkTransparent)
	c := canvas{memDC}

	v := app.ctl.View()
	app.view = v
	if key := app.promptKeyOf(v.Prompt); key != app.promptKey {
		app.promptKey, app.promptAt = key, time.Now()
	}
	if v.Placeholder != app.placeholder && app.edit != 0 {
		app.placeholder = v.Placeholder
		procSendMessageW.Call(uintptr(app.edit), emSetCueBanner, 1, uintptr(unsafe.Pointer(utf16Ptr(v.Placeholder))))
	}
	app.hits = app.hits[:0]

	// Canvas: lavender gradient with soft colour glows.
	c.gradient(cr, 0, argb(theme.CanvasTop, 255), argb(theme.CanvasBottom, 255), 1)
	c.glow(rect{-w / 4, h / 3, w / 2, h + h/3}, theme.GlowViolet, 120)
	c.glow(rect{w * 3 / 5, -h / 3, w + w/4, h / 2}, theme.GlowCyan, 110)
	c.glow(rect{w / 3, h * 2 / 3, w * 4 / 5, h + h/4}, theme.GlowPink, 70)

	promptH := app.promptHeight(memDC, v, w, h)
	l := computeLayout(w, h, app.s, promptH)
	app.layout = l

	app.paintTopBar(memDC, l.topbar, v)

	// Frosted main panel.
	c.shadow(l.panel, app.s(22), app.s(14), theme.Shadow, 44)
	c.round(l.panel, app.s(22), argb(theme.Panel, 232))
	c.stroke(l.panel, app.s(22), argb(theme.PanelBorder, 255), 1)
	app.paintRail(memDC, l.rail, v)
	app.paintHeader(memDC, l.header, v)
	app.paintContent(memDC, l.body, v)
	if v.Prompt != nil {
		app.paintPrompt(memDC, l.prompt, v.Prompt)
	}
	app.paintOmnibar(memDC, l, v)
	if l.dock.width() > 0 {
		app.paintDock(memDC, l.dock, v)
	}

	procBitBlt.Call(target, 0, 0, uintptr(w), uintptr(h), memDC, 0, 0, srcCopy)
	procSelectObject.Call(memDC, oldBmp)
	procDeleteObject.Call(bmp)
	procDeleteDC.Call(memDC)
}

func (app *ShellApp) promptHeight(hdc uintptr, v desktop.View, w, h int32) int32 {
	p := v.Prompt
	if p == nil {
		return 0
	}
	l0 := computeLayout(w, h, app.s, 0)
	inner := l0.body.width() - 2*app.s(28) - 2*app.s(22) - app.s(46)
	total := app.s(24) + measure(hdc, app.fonts.h2, inner, p.Title, wrapFlags) + app.s(12) + app.s(40) + app.s(22)
	if p.Body != "" {
		body := measure(hdc, app.fonts.mono, inner-2*app.s(12), p.Body, wrapFlags)
		if limit := h / 3; body > limit {
			body = limit
		}
		total += body + 2*app.s(12) + app.s(16)
	}
	return total
}

func (app *ShellApp) paintTopBar(hdc uintptr, r rect, v desktop.View) {
	c := canvas{hdc}
	c.shadow(r, r.height()/2, app.s(10), theme.Shadow, 36)
	c.round(r, r.height()/2, argb(theme.Panel, 240))
	c.stroke(r, r.height()/2, argb(theme.PanelBorder, 255), 1)
	logo := rect{r.Left + app.s(10), r.Top + app.s(10), r.Left + app.s(10) + app.s(36), r.Top + app.s(10) + app.s(36)}
	c.gradient(logo, app.s(10), argb(theme.AccentLight, 255), argb(theme.AccentDark, 255), 2)
	text(hdc, app.fonts.icon, theme.TextOnAccent, logo, glyph("send"), dtSingleLine|dtVCenter|dtCenter)
	x := logo.Right + app.s(12)
	text(hdc, app.fonts.brand, theme.TextPrimary, rect{x, r.Top, x + app.s(130), r.Bottom}, "SwypikOS", lineFlags)
	x += textWidth(hdc, app.fonts.brand, "SwypikOS") + app.s(18)
	c.round(rect{x, r.Top + app.s(14), x + 1, r.Bottom - app.s(14)}, 0, argb(theme.Divider, 255))
	x += app.s(18)
	now := time.Now()
	text(hdc, app.fonts.bold, theme.TextPrimary, rect{x, r.Top + app.s(9), x + app.s(140), r.Top + app.s(29)}, now.Format("15:04"), lineFlags)
	days := [...]string{"Dum", "Lun", "Mar", "Mie", "Joi", "Vin", "Sâm"}
	months := [...]string{"ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sept", "oct", "nov", "dec"}
	text(hdc, app.fonts.small, theme.TextSecondary, rect{x, r.Top + app.s(28), x + app.s(140), r.Top + app.s(46)}, fmt.Sprintf("%s %d %s", days[now.Weekday()], now.Day(), months[now.Month()-1]), lineFlags)

	// Right side: activity or connection, then the account avatar.
	av := rect{r.Right - app.s(10) - app.s(36), r.Top + app.s(10), r.Right - app.s(10), r.Top + app.s(46)}
	c.gradient(av, app.s(18), argb(0xA5A3BE, 255), argb(0x7E7B99, 255), 1)
	text(hdc, app.fonts.icon, theme.TextOnAccent, av, glyph("person"), dtSingleLine|dtVCenter|dtCenter)
	status, dot := v.Connection, uint32(theme.Online)
	if v.Busy {
		status, dot = v.BusyLabel+"…", theme.Offline
	}
	sw := textWidth(hdc, app.fonts.small, status)
	if max := app.s(260); sw > max {
		sw = max
	}
	sx := av.Left - app.s(16) - sw
	c.circle(rect{sx - app.s(14), r.Top + r.height()/2 - app.s(4), sx - app.s(6), r.Top + r.height()/2 + app.s(4)}, argb(dot, 255))
	text(hdc, app.fonts.small, theme.TextSecondary, rect{sx, r.Top, av.Left - app.s(12), r.Bottom}, status, lineFlags)
}

func (app *ShellApp) railButton(i int) rect {
	l := app.layout
	size := app.s(44)
	left := l.rail.Left + (l.rail.width()-size)/2
	if desktop.Tab(i) == desktop.TabSettings {
		return rect{left, l.rail.Bottom - app.s(20) - size, left + size, l.rail.Bottom - app.s(20)}
	}
	top := l.rail.Top + app.s(22) + int32(i)*app.s(54)
	if i >= 3 {
		top += app.s(18) // group separator
	}
	return rect{left, top, left + size, top + size}
}

func (app *ShellApp) paintRail(hdc uintptr, r rect, v desktop.View) {
	c := canvas{hdc}
	for i := range desktop.TabNames {
		b := app.railButton(i)
		active := desktop.Tab(i) == v.Tab
		hovered := app.hover == len(app.hits)
		color := uint32(theme.TextSecondary)
		if active {
			c.round(b, app.s(12), argb(theme.AccentSoft, 255))
			color = theme.Accent
		} else if hovered {
			c.round(b, app.s(12), argb(theme.Hover, 255))
		}
		text(hdc, app.fonts.iconLg, color, b, glyph(desktop.TabIcons[i]), dtSingleLine|dtVCenter|dtCenter)
		app.hits = append(app.hits, hit{r: b, kind: hitTab, tab: desktop.Tab(i)})
	}
	sep := app.railButton(3).Top - app.s(10)
	c.round(rect{r.Left + app.s(22), sep, r.Right - app.s(22), sep + 1}, 0, argb(theme.Divider, 255))
}

func (app *ShellApp) paintHeader(hdc uintptr, r rect, v desktop.View) {
	c := canvas{hdc}
	first := "Workspace"
	fw := textWidth(hdc, app.fonts.bold, first)
	text(hdc, app.fonts.bold, theme.TextPrimary, rect{r.Left + app.s(20), r.Top, r.Right, r.Bottom}, first, lineFlags)
	text(hdc, app.fonts.ui, theme.TextMuted, rect{r.Left + app.s(20) + fw + app.s(10), r.Top, r.Right, r.Bottom}, "/   "+desktop.TabNames[v.Tab], lineFlags)
	pill := rect{r.Right - app.s(260), r.Top, r.Right, r.Bottom}
	hovered := app.hover == len(app.hits)
	c.round(pill, pill.height()/2, argb(theme.Surface, 255))
	border := uint32(theme.PanelBorder)
	if hovered {
		border = theme.AccentLight
	}
	c.stroke(pill, pill.height()/2, argb(border, 255), 1)
	text(hdc, app.fonts.icon, theme.TextSecondary, rect{pill.Left + app.s(14), pill.Top, pill.Left + app.s(40), pill.Bottom}, glyph("search"), dtSingleLine|dtVCenter)
	text(hdc, app.fonts.ui, theme.TextMuted, rect{pill.Left + app.s(42), pill.Top, pill.Right - app.s(44), pill.Bottom}, "Caută în indexul tău…", lineFlags)
	key := rect{pill.Right - app.s(36), pill.Top + app.s(8), pill.Right - app.s(12), pill.Bottom - app.s(8)}
	c.stroke(key, app.s(5), argb(theme.PanelBorder, 255), 1)
	text(hdc, app.fonts.small, theme.TextSecondary, key, "/", dtSingleLine|dtVCenter|dtCenter)
	app.hits = append(app.hits, hit{r: pill, kind: hitSearchPill})
}

func (app *ShellApp) paintContent(hdc uintptr, area rect, v desktop.View) {
	pad := app.s(36)
	col := rect{area.Left + pad, area.Top + app.s(18), area.Right - pad, area.Bottom}
	colW := col.width()
	if colW < app.s(200) {
		return
	}
	items, total := app.layoutContent(hdc, v, colW)
	viewH := col.height()
	maxOff := total - viewH
	if maxOff < 0 {
		maxOff = 0
	}
	tab := v.Tab
	app.maxScroll[tab] = maxOff
	if app.stick[tab] {
		app.scroll[tab] = maxOff
	}
	if app.scroll[tab] > maxOff {
		app.scroll[tab] = maxOff
	}
	if app.scroll[tab] < 0 {
		app.scroll[tab] = 0
	}
	saved, _, _ := procSaveDC.Call(hdc)
	procIntersectClipRect.Call(hdc, uintptr(area.Left), uintptr(area.Top), uintptr(area.Right), uintptr(area.Bottom))
	off := col.Top - app.scroll[tab]
	for _, it := range items {
		r := rect{col.Left + it.r.Left, off + it.r.Top, col.Left + it.r.Right, off + it.r.Bottom}
		if r.Bottom < area.Top || r.Top > area.Bottom {
			continue
		}
		action := ""
		if it.tile != nil {
			action = it.tile.Action
		} else if it.block != nil {
			action = it.block.Action
		}
		hovered := false
		if action != "" {
			visible := r
			if visible.Top < area.Top {
				visible.Top = area.Top
			}
			if visible.Bottom > area.Bottom {
				visible.Bottom = area.Bottom
			}
			hovered = app.hover == len(app.hits)
			app.hits = append(app.hits, hit{r: visible, kind: hitAction, action: action})
		}
		switch {
		case it.isHead:
			app.drawHeading(hdc, v, r)
		case it.tile != nil:
			app.drawTile(hdc, *it.tile, r, hovered)
		case it.block != nil:
			app.drawBlock(hdc, *it.block, r, hovered)
		}
	}
	if len(v.Blocks) == 0 && len(v.Tiles) == 0 && v.Empty != "" {
		text(hdc, app.fonts.empty, theme.TextMuted, rect{area.Left, off + total, area.Right, area.Bottom - app.s(40)}, v.Empty, dtSingleLine|dtVCenter|dtCenter)
	}
	procRestoreDC.Call(hdc, saved)
	if total > viewH && viewH > 0 {
		c := canvas{hdc}
		trackH := area.height() - app.s(24)
		thumbH := trackH * viewH / total
		if thumbH < app.s(28) {
			thumbH = app.s(28)
		}
		top := area.Top + app.s(12)
		if maxOff > 0 {
			top += (trackH - thumbH) * app.scroll[tab] / maxOff
		}
		c.round(rect{area.Right - app.s(12), top, area.Right - app.s(7), top + thumbH}, app.s(3), argb(theme.TextMuted, 140))
	}
}

func (app *ShellApp) paintPrompt(hdc uintptr, r rect, p *desktop.Prompt) {
	c := canvas{hdc}
	accent, soft, border := uint32(theme.Accent), uint32(theme.AccentSoft), uint32(theme.AccentLight)
	icon := "sparkle"
	if p.Approval {
		accent, soft, border, icon = theme.WarnText, theme.WarnBg, theme.WarnBorder, "warning"
	}
	c.shadow(r, app.s(18), app.s(10), theme.Shadow, 44)
	c.round(r, app.s(18), argb(theme.Surface, 255))
	c.stroke(r, app.s(18), argb(border, 255), 1.5)
	pad := app.s(22)
	ic := rect{r.Left + pad, r.Top + app.s(20), r.Left + pad + app.s(32), r.Top + app.s(20) + app.s(32)}
	c.round(ic, app.s(10), argb(soft, 255))
	text(hdc, app.fonts.icon, accent, ic, glyph(icon), dtSingleLine|dtVCenter|dtCenter)
	inner := rect{ic.Right + app.s(14), r.Top + app.s(20), r.Right - pad, r.Bottom - pad}
	th := measure(hdc, app.fonts.h2, inner.width(), p.Title, wrapFlags)
	text(hdc, app.fonts.h2, theme.TextPrimary, rect{inner.Left, inner.Top + app.s(4), inner.Right, inner.Top + app.s(4) + th}, p.Title, wrapFlags)
	y := inner.Top + app.s(4) + th + app.s(12)
	by := r.Bottom - app.s(20) - app.s(40)
	if p.Body != "" {
		box := rect{inner.Left, y, inner.Right, by - app.s(16)}
		c.round(box, app.s(12), argb(theme.SurfaceSoft, 255))
		saved, _, _ := procSaveDC.Call(hdc)
		procIntersectClipRect.Call(hdc, uintptr(box.Left), uintptr(box.Top), uintptr(box.Right), uintptr(box.Bottom))
		text(hdc, app.fonts.mono, theme.TextPrimary, rect{box.Left + app.s(12), box.Top + app.s(12), box.Right - app.s(12), box.Bottom}, p.Body, wrapFlags)
		procRestoreDC.Call(hdc, saved)
	}
	confirm := rect{inner.Left, by, inner.Left + app.s(170), by + app.s(40)}
	reject := rect{confirm.Right + app.s(10), by, confirm.Right + app.s(10) + app.s(150), by + app.s(40)}
	if app.promptReady() {
		c.gradient(confirm, app.s(20), argb(theme.AccentLight, 255), argb(theme.AccentDark, 255), 0)
	} else {
		c.round(confirm, app.s(20), argb(theme.TextMuted, 255)) // not yet accepting input
	}
	text(hdc, app.fonts.bold, theme.TextOnAccent, confirm, p.Confirm, dtSingleLine|dtVCenter|dtCenter)
	c.round(reject, app.s(20), argb(theme.Surface, 255))
	c.stroke(reject, app.s(20), argb(theme.PanelBorder, 255), 1)
	text(hdc, app.fonts.bold, theme.TextPrimary, reject, p.Reject, dtSingleLine|dtVCenter|dtCenter)
	app.hits = append(app.hits, hit{r: confirm, kind: hitConfirm}, hit{r: reject, kind: hitReject})
	if p.Approval {
		text(hdc, app.fonts.small, theme.WarnText, rect{reject.Right + app.s(16), by, inner.Right, by + app.s(40)}, "Pasul rulează cu permisiunile tale.", lineFlags)
	}
}

func (app *ShellApp) paintOmnibar(hdc uintptr, l layout, v desktop.View) {
	c := canvas{hdc}
	r := l.omni
	c.shadow(r, r.height()/2, app.s(12), theme.Shadow, 46)
	c.round(r, r.height()/2, argb(theme.Surface, 255))
	c.stroke(r, r.height()/2, argb(0xD9D2FA, 255), 1.5)
	text(hdc, app.fonts.small, theme.TextSecondary, l.keycap, "Ctrl L", dtSingleLine|dtVCenter|dtCenter)
	c.stroke(l.keycap, app.s(6), argb(theme.PanelBorder, 255), 1)
	stop := v.Live && v.Prompt == nil
	if stop {
		c.gradient(l.send, l.send.height()/2, argb(0xF87171, 255), argb(0xDC2626, 255), 1)
	} else {
		c.gradient(l.send, l.send.height()/2, argb(theme.AccentLight, 255), argb(theme.AccentDark, 255), 1)
	}
	g := "send"
	if stop {
		g = "stop"
	}
	text(hdc, app.fonts.iconLg, theme.TextOnAccent, l.send, glyph(g), dtSingleLine|dtVCenter|dtCenter)
	app.hits = append(app.hits, hit{r: l.send, kind: hitSend})
	text(hdc, app.fonts.small, theme.TextMuted, l.hint, "Încearcă „agent”, „/index” sau „/crawl URL”, ori întreab-o pe Ilaria.  ·  Esc anulează  ·  /help", dtSingleLine|dtCenter|dtEndEllipsis)
}

func (app *ShellApp) paintDock(hdc uintptr, r rect, v desktop.View) {
	c := canvas{hdc}
	c.shadow(r, app.s(16), app.s(8), theme.Shadow, 32)
	c.round(r, app.s(16), argb(theme.Panel, 240))
	c.stroke(r, app.s(16), argb(theme.PanelBorder, 255), 1)
	procSetTextCharacterExtra.Call(hdc, uintptr(app.s(1)))
	text(hdc, app.fonts.smallBold, theme.TextSecondary, rect{r.Left + app.s(14), r.Top + app.s(8), r.Right, r.Top + app.s(26)}, "FIXATE", lineFlags)
	procSetTextCharacterExtra.Call(hdc, 0)
	x := r.Left + app.s(12)
	for _, t := range []desktop.Tab{desktop.TabChat, desktop.TabAgent, desktop.TabSearch} {
		chip := rect{x, r.Top + app.s(32), x + app.s(68), r.Bottom - app.s(10)}
		hovered := app.hover == len(app.hits)
		bg := uint32(theme.Surface)
		if hovered || v.Tab == t {
			bg = theme.AccentSoft
		}
		c.round(chip, app.s(10), argb(bg, 255))
		c.stroke(chip, app.s(10), argb(theme.PanelBorder, 255), 1)
		text(hdc, app.fonts.iconSm, theme.Accent, rect{chip.Left + app.s(8), chip.Top, chip.Left + app.s(24), chip.Bottom}, glyph(desktop.TabIcons[t]), dtSingleLine|dtVCenter)
		text(hdc, app.fonts.small, theme.TextPrimary, rect{chip.Left + app.s(26), chip.Top, chip.Right - app.s(4), chip.Bottom}, desktop.TabNames[t], lineFlags)
		app.hits = append(app.hits, hit{r: chip, kind: hitTab, tab: t})
		x = chip.Right + app.s(8)
	}
}

// ---------------------------------------------------------------- window procedure

// osPointer converts a pointer that Windows passed in a message parameter. The
// memory belongs to the OS for the duration of the message, not the Go heap.
func osPointer(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

func wndProc(hwnd syscall.Handle, message uint32, wParam, lParam uintptr) uintptr {
	app := globalApp
	if app == nil || app.handle() == 0 {
		r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(message), wParam, lParam)
		return r
	}
	switch message {
	case wmClose:
		app.report("Win32 WM_CLOSE received")
		app.ctl.Cancel()
		if r, _, err := procDestroyWindow.Call(uintptr(hwnd)); r == 0 {
			app.report(fmt.Sprintf("Win32 DestroyWindow failed: %v", err))
		}
		return 0
	case wmDestroy:
		app.report("Win32 WM_DESTROY received")
		procPostQuitMessage.Call(0)
		return 0
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		var ps paintStruct
		hdc, _, _ := procBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		app.paint(hdc)
		procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0
	case wmSize:
		app.placeEdit()
		app.invalidate()
		return 0
	case wmSetFocus:
		procSetFocus.Call(uintptr(app.edit))
		return 0
	case wmRepaint:
		app.invalidate()
		return 0
	case wmTimer:
		minute := time.Now().Minute()
		if app.view.Live || minute != app.minute || (app.view.Prompt != nil && time.Since(app.promptAt) < approvalDwell+400*time.Millisecond) {
			app.minute = minute
			app.invalidate()
		}
		return 0
	case wmMouseMove:
		x, y := loword(lParam), hiword(lParam)
		hover := -1
		for i, h := range app.hits {
			if h.r.contains(x, y) {
				hover = i
				break
			}
		}
		if hover != app.hover {
			app.hover = hover
			app.invalidate()
		}
		return 0
	case wmSetCursor:
		if syscall.Handle(wParam) == hwnd && loword(lParam) == htClient {
			id := uintptr(idcArrow)
			if app.hover >= 0 {
				id = idcHand
			}
			cur, _, _ := procLoadCursorW.Call(0, id)
			procSetCursor.Call(cur)
			return 1
		}
	case wmLButtonDown:
		app.click(loword(lParam), hiword(lParam))
		return 0
	case wmMouseWheel:
		delta := hiword(wParam)
		app.scrollBy(abs32(delta)*app.s(56)/120, delta > 0)
		return 0
	case wmChar:
		// Text posted to the main window (for example by automation) goes to
		// the input field; Enter submits it.
		if wParam == vkReturn {
			t := windowText(app.edit)
			setWindowText(app.edit, "")
			app.submit(t)
		} else {
			procSendMessageW.Call(uintptr(app.edit), wmChar, wParam, lParam)
		}
		return 0
	case wmCtlColorEdit:
		procSetTextColor.Call(wParam, colorRef(theme.TextPrimary))
		procSetBkColor.Call(wParam, colorRef(theme.Surface))
		return app.editBrush
	case wmGetMinMaxInfo:
		info := (*minMaxInfo)(osPointer(lParam))
		info.MinTrackSize = point{app.s(900), app.s(620)}
		return 0
	case wmDpiChanged:
		app.dpi = loword(wParam)
		app.createFonts()
		suggested := (*rect)(osPointer(lParam))
		procSetWindowPos.Call(uintptr(hwnd), 0, uintptr(suggested.Left), uintptr(suggested.Top), uintptr(suggested.width()), uintptr(suggested.height()), swpNoZOrder|swpNoActivate)
		app.placeEdit()
		app.invalidate()
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(message), wParam, lParam)
	return r
}

// ---------------------------------------------------------------- lifecycle

func enableDPIAwareness() {
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
	if procSetProcessDpiAwarenessC.Find() == nil {
		if r, _, _ := procSetProcessDpiAwarenessC.Call(^uintptr(3)); r != 0 {
			return
		}
	}
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}
}

// styleFrame asks Windows 11 for rounded corners and a caption that matches
// the canvas. Older systems ignore these attributes.
func styleFrame(hwnd uintptr) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	set := func(attr uintptr, v uint32) {
		procDwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&v)), 4)
	}
	set(33, 2) // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND
	set(34, uint32(colorRef(theme.CanvasTop)))
	set(35, uint32(colorRef(theme.CanvasTop)))
	set(36, uint32(colorRef(theme.TextPrimary)))
}

// Run creates the window and runs the message loop until the window closes.
func (app *ShellApp) Run() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	enableDPIAwareness()
	token, ok := startGDIPlus()
	if !ok {
		return fmt.Errorf("GDI+ is unavailable")
	}
	defer stopGDIPlus(token)
	globalApp = app
	defer func() { globalApp = nil }()

	instance, _, err := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return fmt.Errorf("GetModuleHandleW failed: %v", err)
	}
	className := utf16Ptr(ClassName)
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	icon, _, _ := procLoadIconW.Call(instance, uintptr(unsafe.Pointer(utf16Ptr("APP"))))
	wc := wndClassEx{Style: 0x0003, WndProc: syscall.NewCallback(wndProc), Instance: syscall.Handle(instance), Cursor: syscall.Handle(cursor), Icon: syscall.Handle(icon), IconSm: syscall.Handle(icon), ClassName: className}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		return fmt.Errorf("RegisterClassExW failed: %v", err)
	}
	defer func() {
		app.report("Win32 unregistering window class")
		procUnregisterClassW.Call(uintptr(unsafe.Pointer(className)), instance)
	}()

	hwnd, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(utf16Ptr("SwypikOS"))),
		wsOverlappedWin|wsClipChildren, 80, 60, 1280, 820, 0, 0, instance, 0)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW failed: %v", err)
	}
	styleFrame(hwnd)
	if procGetDpiForWindow.Find() == nil {
		if d, _, _ := procGetDpiForWindow.Call(hwnd); d != 0 {
			app.dpi = int32(d)
		}
	}
	app.createFonts()
	defer app.deleteFonts()
	brush, _, _ := procCreateSolidBrush.Call(colorRef(theme.Surface))
	app.editBrush = brush
	defer procDeleteObject.Call(brush)

	edit, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(utf16Ptr("EDIT"))), 0, wsChild|wsVisible|esAutoHScroll, 0, 0, 10, 10, hwnd, 0, instance, 0)
	if edit == 0 {
		procDestroyWindow.Call(hwnd)
		return fmt.Errorf("create input field: %v", err)
	}
	app.edit = syscall.Handle(edit)
	procSendMessageW.Call(edit, wmSetFont, uintptr(app.fonts.ui), 1)
	procSendMessageW.Call(edit, 0x00C5, 4000, 0) // EM_LIMITTEXT
	app.hwnd.Store(hwnd)
	defer func() {
		app.hwnd.Store(0)
		procKillTimer.Call(hwnd, 1)
		if ok, _, _ := procIsWindow.Call(hwnd); ok != 0 {
			procDestroyWindow.Call(hwnd)
		}
	}()
	if t, _, err := procSetTimer.Call(hwnd, 1, 300, 0); t == 0 {
		return fmt.Errorf("SetTimer failed: %v", err)
	}
	// Scale the initial size to the monitor's DPI.
	procSetWindowPos.Call(hwnd, 0, uintptr(app.s(80)), uintptr(app.s(60)), uintptr(app.s(1280)), uintptr(app.s(820)), swpNoZOrder|swpNoActivate)
	app.placeEdit()
	procShowWindow.Call(hwnd, swShowMaximized)
	procUpdateWindow.Call(hwnd)
	procSetFocus.Call(edit)
	app.report("Win32 window ready")

	var m msg
	for {
		r, _, callErr := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		quit, err := nativeMessageResult(r, callErr)
		if err != nil {
			return err
		}
		if quit {
			app.report("Win32 WM_QUIT received")
			return nil
		}
		if app.preTranslate(&m) {
			continue
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}
