//go:build windows

// Package engine is the native Win32 front end of the SwypikOS desktop. It
// reproduces the original Swypik design (ui/web/desktop.css at 420cd74) with
// GDI+ shapes, the embedded Plus Jakarta Sans face and the original SVG icon
// set. It uses no browser, WebView or HTTP server.
package engine

import (
	"fmt"
	"hash/fnv"
	"runtime"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	resourcepolicy "swypik-os/core/resource"
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
	hitSearchBox
	hitCategory
	hitChatToggle
	hitChatExpand
	hitChatClose
	hitWorkspaceExpand
	hitFullscreen
	hitRefresh
)

type hit struct {
	r      rect
	kind   hitKind
	tab    desktop.Tab
	action string
	index  int
}

type fontKey struct {
	px     int32 // CSS pixels
	weight int
	mono   bool
}

// Navigation as in the original desktop: quick pills under the top capsule
// and the rail inside the main window.
type navItem struct {
	tab   desktop.Tab
	icon  string
	label string
}

var quickPills = []navItem{
	{desktop.TabFiles, "folder", "Workspace"},
	{desktop.TabHome, "grid", "Swypik Apps"},
	{desktop.TabSearch, "globe", "Căutare"},
	{desktop.TabAgent, "terminal", "Agent"},
}

var railTop = []navItem{{desktop.TabHome, "grid", ""}, {desktop.TabFiles, "folder", ""}, {desktop.TabSearch, "globe", ""}}
var railMid = []navItem{{desktop.TabAgent, "terminal", ""}, {desktop.TabCompute, "spark", ""}}

type ShellApp struct {
	ctl                   *desktop.Controller
	hwnd                  atomic.Uintptr // read by Notify from any goroutine
	edit                  syscall.Handle
	dpi                   int32
	fonts                 map[fontKey]syscall.Handle
	editBrush             uintptr
	scroll                [desktop.TabCount]int32
	maxScroll             [desktop.TabCount]int32
	stick                 [desktop.TabCount]bool
	chatScroll            int32
	chatMax               int32
	chatStick             bool
	hits                  []hit
	hover                 int
	promptKey             string
	promptAt              time.Time
	heights               map[uint64]int32
	view                  desktop.View
	lifecycle             func(string)
	layout                layout
	placeholder           string
	minute                int
	ready                 atomic.Bool // fonts warmed; until then paint only the background
	wall                  wallpaper
	paints                int
	expanded              bool // workspace-expanded: hide capsule, pills and deck
	chatExpanded          bool
	fullscreen            bool
	savedStyle            uintptr
	savedRect             rect
	category              int
	editRect              rect
	focused               bool
	timerMS               uintptr
	backDC                uintptr
	backBmp               uintptr
	backOldBmp            uintptr
	backBits              uintptr
	backW                 int32
	backH                 int32
	backRelease           func()
	releaseIdleBackbuffer bool
	lastPaint             time.Time
}

var globalApp *ShellApp

func NewShellApp(ctl *desktop.Controller) *ShellApp {
	policy := resourcepolicy.Default()
	app := &ShellApp{
		ctl:                   ctl,
		hover:                 -1,
		heights:               map[uint64]int32{},
		dpi:                   96,
		fonts:                 map[fontKey]syscall.Handle{},
		chatStick:             true,
		releaseIdleBackbuffer: policy.Profile != resourcepolicy.ProfilePerformance,
	}
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

func (app *ShellApp) dropBackbuffer() {
	if app.backRelease != nil {
		app.backRelease()
		app.backRelease = nil
	}
	if app.backDC != 0 && app.backOldBmp != 0 {
		procSelectObject.Call(app.backDC, app.backOldBmp)
	}
	if app.backBmp != 0 {
		procDeleteObject.Call(app.backBmp)
	}
	if app.backDC != 0 {
		procDeleteDC.Call(app.backDC)
	}
	app.backDC, app.backBmp, app.backOldBmp, app.backBits = 0, 0, 0, 0
	app.backW, app.backH = 0, 0
}

func (app *ShellApp) ensureBackbuffer(target uintptr, w, h int32) bool {
	if app.backDC != 0 && app.backBmp != 0 && app.backW == w && app.backH == h {
		return true
	}
	app.dropBackbuffer()
	memDC, _, _ := procCreateCompatibleDC.Call(target)
	if memDC == 0 {
		return false
	}
	bi := bitmapInfoHeader{Size: 40, Width: w, Height: -h, Planes: 1, BitCount: 32}
	var bits uintptr
	bmp, _, _ := procCreateDIBSection.Call(target, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		procDeleteDC.Call(memDC)
		return false
	}
	oldBmp, _, _ := procSelectObject.Call(memDC, bmp)
	app.backDC = memDC
	app.backBmp = bmp
	app.backOldBmp = oldBmp
	app.backBits = bits
	app.backW, app.backH = w, h
	app.backRelease = bindSurface(memDC, bits, w, h)
	return true
}

func (app *ShellApp) desiredTimerMS() uintptr {
	if app.view.Live || app.view.ChatBusy ||
		(app.view.Prompt != nil && time.Since(app.promptAt) < approvalDwell+400*time.Millisecond) {
		return 250
	}
	if app.releaseIdleBackbuffer && app.backDC != 0 && !app.lastPaint.IsZero() {
		const keepWarm = 2 * time.Second
		remaining := keepWarm - time.Since(app.lastPaint)
		if remaining > 0 {
			ms := remaining.Milliseconds()
			if ms < 250 {
				ms = 250
			}
			return uintptr(ms)
		}
		return 250
	}
	now := time.Now()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	ms := time.Until(nextMinute).Milliseconds()
	if ms < 1000 {
		ms = 1000
	}
	if ms > 60000 {
		ms = 60000
	}
	return uintptr(ms)
}

func (app *ShellApp) updateTimer() {
	hwnd := app.handle()
	if hwnd == 0 {
		return
	}
	desired := app.desiredTimerMS()
	if desired == app.timerMS {
		return
	}
	if app.timerMS != 0 {
		procKillTimer.Call(hwnd, 1)
	}
	if timer, _, _ := procSetTimer.Call(hwnd, 1, desired, 0); timer != 0 {
		app.timerMS = desired
	}
}

// ---------------------------------------------------------------- layout

type chatMode int

const (
	chatHidden chatMode = iota
	chatPanel
	chatOverlay
)

type layoutInput struct {
	expanded bool
	chat     chatMode
	chatH    int32 // wanted height of the chat panel content
	promptH  int32
}

type layout struct {
	capsule, pills, main, rail, content, toolbar, view, prompt rect
	omni, hint, deck, chat, overlay                            rect
	wide, narrow, showDeck, showTop                            bool
}

func minI(a, b int32) int32 {
	if a < b {
		return a
	}
	return b
}

func maxI(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

// computeLayout mirrors the original stylesheet's geometry. It is pure so it
// can be tested.
func computeLayout(w, h int32, s func(int32) int32, in layoutInput) layout {
	var l layout
	l.wide, l.narrow = w >= s(1550), w <= s(1200)
	hintH := s(22)
	l.showTop = !in.expanded
	if in.expanded {
		l.main = rect{s(10), s(10), w - s(10), h - s(100)}
		l.omni = rect{s(83), h - s(12) - hintH - s(65), w - s(20), h - s(12) - hintH}
	} else {
		top := s(24)
		if l.wide {
			top = s(35)
		}
		cw := minI(s(740), w-s(40))
		l.capsule = rect{(w - cw) / 2, top, (w-cw)/2 + cw, top + s(62)}
		l.pills = rect{0, l.capsule.Bottom + s(24), w, l.capsule.Bottom + s(24) + s(52)}
		bottomGap := s(23)
		if l.wide {
			bottomGap = s(35)
		}
		ow := minI(s(700), w-s(40))
		l.omni = rect{(w - ow) / 2, h - bottomGap - hintH - s(65), (w-ow)/2 + ow, h - bottomGap - hintH}
		mw := minI(s(1240), w-s(96))
		if l.narrow {
			mw = w - s(42)
		}
		gap := s(28)
		if l.wide {
			gap = s(38)
		}
		mt := l.pills.Bottom + gap
		mh := h - s(316)
		if l.wide {
			mh = h - s(350)
		}
		mh = maxI(s(310), minI(s(780), mh))
		mh = minI(mh, l.omni.Top-s(18)-mt)
		l.main = rect{(w - mw) / 2, mt, (w-mw)/2 + mw, mt + maxI(mh, s(160))}
		if !l.narrow {
			left, bottom := s(30), h-s(31)
			if l.wide {
				left, bottom = s(40), h-s(45)
			}
			l.deck = rect{left, bottom - s(78), left + s(250), bottom}
			l.showDeck = l.deck.Right+s(12) < l.omni.Left
		}
	}
	l.hint = rect{l.omni.Left, l.omni.Bottom + s(9), l.omni.Right, l.omni.Bottom + hintH}
	l.rail = rect{l.main.Left + s(10), l.main.Top + s(10), l.main.Left + s(10) + s(63), l.main.Bottom - s(10)}
	l.content = rect{l.rail.Right, l.main.Top + s(10), l.main.Right - s(10), l.main.Bottom - s(10)}
	tb := s(61)
	if in.expanded {
		tb = s(52)
	}
	l.toolbar = rect{l.content.Left, l.content.Top, l.content.Right, l.content.Top + tb}
	l.view = rect{l.content.Left, l.toolbar.Bottom, l.content.Right, l.content.Bottom}
	if in.promptH > 0 {
		ph := minI(in.promptH, l.view.height()-s(60))
		l.prompt = rect{l.content.Left + s(16), l.content.Bottom - s(14) - ph, l.content.Right - s(16), l.content.Bottom - s(14)}
		l.view.Bottom = l.prompt.Top - s(6)
	}
	switch in.chat {
	case chatPanel:
		ch := minI(in.chatH, minI(s(360), h*45/100)) + s(45) + s(26)
		l.chat = rect{l.omni.Left, l.omni.Top - s(4) - ch, l.omni.Right, l.omni.Top - s(4)}
	case chatOverlay:
		l.showDeck = false // covered by the overlay
		l.overlay = rect{s(12), s(12), w - s(12), h - s(12)}
		l.hint = rect{l.overlay.Left + s(14), l.overlay.Bottom - s(14) - s(12), l.overlay.Right - s(14), l.overlay.Bottom - s(14)}
		l.omni = rect{l.overlay.Left + s(14), l.hint.Top - s(12) - s(65), l.overlay.Right - s(14), l.hint.Top - s(12)}
		l.chat = rect{l.overlay.Left + s(14), l.overlay.Top + s(14), l.overlay.Right - s(14), l.omni.Top - s(12)}
	}
	return l
}

// Omnibar interior, right to left: execute button, kbd, expand, chat.
type omniParts struct{ input, chatBtn, expandBtn, kbd, exec rect }

func (app *ShellApp) omniParts(o rect) omniParts {
	var p omniParts
	cy := o.Top + o.height()/2
	p.exec = rect{o.Right - app.s(8) - app.s(49), cy - app.s(49)/2, o.Right - app.s(8), cy - app.s(49)/2 + app.s(49)}
	p.kbd = rect{p.exec.Left - app.s(12) - app.s(54), cy - app.s(15), p.exec.Left - app.s(12), cy + app.s(15)}
	p.expandBtn = rect{p.kbd.Left - app.s(12) - app.s(31), cy - app.s(16), p.kbd.Left - app.s(12), cy + app.s(15)}
	p.chatBtn = rect{p.expandBtn.Left - app.s(4) - app.s(31), cy - app.s(16), p.expandBtn.Left - app.s(4), cy + app.s(15)}
	p.input = rect{o.Left + app.s(26), cy - app.s(11), p.chatBtn.Left - app.s(12), cy + app.s(11)}
	return p
}

// ---------------------------------------------------------------- fonts

var (
	procGetTextFaceW          = gdi32.NewProc("GetTextFaceW")
	procSetTextCharacterExtra = gdi32.NewProc("SetTextCharacterExtra")
	procGetTextCharacterExtra = gdi32.NewProc("GetTextCharacterExtra")
	procGetDC                 = user32.NewProc("GetDC")
	procReleaseDC             = user32.NewProc("ReleaseDC")
	dwmapi                    = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	procLoadIconW             = user32.NewProc("LoadIconW")
)

// installedFace returns the first face the system actually has.
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

var faceCache = map[int]string{}
var monoFace string

// faceFor maps a CSS weight to the embedded Plus Jakarta Sans face.
func faceFor(weight int) (string, int) {
	if f, ok := faceCache[weight]; ok {
		w := 400
		if weight == 700 {
			w = 700
		}
		return f, w
	}
	var f string
	switch weight {
	case 500:
		f = installedFace("Plus Jakarta Sans Medium", "Plus Jakarta Sans", "Segoe UI")
	case 600:
		f = installedFace("Plus Jakarta Sans SemiBold", "Plus Jakarta Sans", "Segoe UI")
	case 800:
		f = installedFace("Plus Jakarta Sans ExtraBold", "Plus Jakarta Sans", "Segoe UI")
	default:
		f = installedFace("Plus Jakarta Sans", "Segoe UI")
	}
	faceCache[weight] = f
	return faceFor(weight)
}

// font returns a cached GDI font for a CSS size and weight at the current DPI.
func (app *ShellApp) font(px int32, weight int) syscall.Handle {
	return app.fontOf(fontKey{px, weight, false})
}
func (app *ShellApp) mono(px int32) syscall.Handle { return app.fontOf(fontKey{px, 400, true}) }

func (app *ShellApp) fontOf(k fontKey) syscall.Handle {
	if f, ok := app.fonts[k]; ok {
		return f
	}
	face, w := faceFor(k.weight)
	if k.mono {
		if monoFace == "" {
			monoFace = installedFace("Cascadia Mono", "Consolas")
		}
		face, w = monoFace, 400
	}
	height := -app.s(k.px)
	f, _, _ := procCreateFontW.Call(uintptr(height), 0, 0, 0, uintptr(w), 0, 0, 0, 1, 0, 0, cleartypeQuality, 0, uintptr(unsafe.Pointer(utf16Ptr(face))))
	app.fonts[k] = syscall.Handle(f)
	return syscall.Handle(f)
}

func (app *ShellApp) resetFonts() {
	for _, f := range app.fonts {
		procDeleteObject.Call(uintptr(f))
	}
	app.fonts = map[fontKey]syscall.Handle{}
	app.heights = map[uint64]int32{}
	measureCache = map[measureKey][2]int32{}
	app.dropWallpaper()
	if app.edit != 0 {
		procSendMessageW.Call(uintptr(app.edit), wmSetFont, uintptr(app.font(13, 400)), 1)
	}
}

// ---------------------------------------------------------------- text

const wrapFlags = dtWordBreak | dtExpandTabs | dtEditControl
const lineFlags = dtSingleLine | dtVCenter | dtEndEllipsis

func text(hdc uintptr, font syscall.Handle, color uint32, r rect, s string, flags uintptr) {
	if s == "" {
		return
	}
	procSelectObject.Call(hdc, uintptr(font))
	procSetTextColor.Call(hdc, colorRef(color))
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16Ptr(s))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags|dtNoPrefix)
}

// spaced draws text with CSS letter-spacing (in CSS pixels, may be negative).
func (app *ShellApp) spaced(hdc uintptr, font syscall.Handle, color uint32, r rect, s string, flags uintptr, spacing float64) {
	procSetTextCharacterExtra.Call(hdc, uintptr(int32(spacing*float64(app.dpi)/96)))
	text(hdc, font, color, r, s, flags)
	procSetTextCharacterExtra.Call(hdc, 0)
}

func measure(hdc uintptr, font syscall.Handle, width int32, s string, flags uintptr) int32 {
	_, h := measureBox(hdc, font, width, s, flags)
	return h
}

type measureKey struct {
	font         syscall.Handle
	width, extra int32
	flags        uintptr
	text         string
}

// measureCache holds DT_CALCRECT results. Font handles change on DPI change,
// which also resets the cache (resetFonts). Only the UI thread measures.
var measureCache = map[measureKey][2]int32{}

const (
	maxMeasureCacheEntries = 2048
	maxHeightCacheEntries  = 512
)

func measureBox(hdc uintptr, font syscall.Handle, width int32, s string, flags uintptr) (int32, int32) {
	if s == "" {
		return 0, 0
	}
	extra, _, _ := procGetTextCharacterExtra.Call(hdc)
	key := measureKey{font, width, int32(extra), flags, s}
	if v, ok := measureCache[key]; ok {
		return v[0], v[1]
	}
	if len(measureCache) >= maxMeasureCacheEntries {
		measureCache = map[measureKey][2]int32{}
	}
	procSelectObject.Call(hdc, uintptr(font))
	r := rect{0, 0, width, 0}
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(utf16Ptr(s))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags|dtCalcRect|dtNoPrefix)
	measureCache[key] = [2]int32{r.Right, r.Bottom}
	return r.Right, r.Bottom
}

func (app *ShellApp) textWidth(hdc uintptr, font syscall.Handle, s string, spacing float64) int32 {
	procSetTextCharacterExtra.Call(hdc, uintptr(int32(spacing*float64(app.dpi)/96)))
	w, _ := measureBox(hdc, font, 1<<20, s, dtSingleLine)
	procSetTextCharacterExtra.Call(hdc, 0)
	return w
}

// ---------------------------------------------------------------- blocks

// blockGeometry returns a block's height and horizontal extent within a
// column of width colW. Heights are cached per content and width.
func (app *ShellApp) blockGeometry(hdc uintptr, b desktop.Block, colW int32) (h, x0, x1 int32) {
	pad := app.s(15)
	if b.Kind == desktop.KindUser {
		maxW := colW * 72 / 100
		tw, th := measureBox(hdc, app.font(12, 400), maxW-2*pad, b.Body, wrapFlags)
		return th + 2*app.s(11), colW - tw - 2*pad, colW
	}
	x0, x1 = 0, colW
	key := fnv.New64a()
	fmt.Fprintf(key, "%d|%d|%d|%s|%s|%s|%s", b.Kind, colW, app.dpi, b.Title, b.Body, b.Action, b.Icon)
	sum := key.Sum64()
	if v, ok := app.heights[sum]; ok {
		return v, x0, x1
	}
	inner := colW - 2*pad
	if app.blockIcon(b) != "" {
		inner -= app.s(44)
	}
	total := 2 * pad
	if t := blockTitle(b); t != "" {
		total += measure(hdc, app.font(12, 700), inner, t, wrapFlags) + app.s(5)
	}
	total += measure(hdc, app.blockFont(b), inner, b.Body, wrapFlags)
	if app.blockIcon(b) != "" && total < app.s(30)+2*pad {
		total = app.s(30) + 2*pad
	}
	if len(app.heights) >= maxHeightCacheEntries {
		app.heights = map[uint64]int32{}
	}
	app.heights[sum] = total
	return total, x0, x1
}

func blockTitle(b desktop.Block) string {
	if b.Kind == desktop.KindAssistant && b.Title == "" {
		return "Ilaria"
	}
	return b.Title
}

func (app *ShellApp) blockFont(b desktop.Block) syscall.Handle {
	if b.Kind == desktop.KindCode || (b.Kind == desktop.KindTool && b.Icon == "") {
		return app.mono(11)
	}
	return app.font(12, 400)
}

func (app *ShellApp) blockIcon(b desktop.Block) string {
	if b.Icon != "" {
		return b.Icon
	}
	switch b.Kind {
	case desktop.KindError:
		return "alert"
	case desktop.KindTool:
		return "code"
	case desktop.KindResult:
		if strings.HasPrefix(b.Action, "files:") {
			if strings.HasSuffix(b.Title, "/") || b.Title == ".." || strings.HasPrefix(b.Title, "←") {
				return "folder"
			}
			return "file"
		}
		if strings.HasPrefix(b.Action, "open:file:") {
			return "file"
		}
		return "globe"
	case desktop.KindInfo:
		return "info"
	case desktop.KindAssistant:
		return "brand"
	}
	return ""
}

func (app *ShellApp) blockTone(b desktop.Block) theme.Tone {
	switch b.Kind {
	case desktop.KindError:
		return theme.Tone{From: 0xFFE9F0, To: 0xFCE0EA, Icon: theme.ErrorText}
	case desktop.KindResult:
		if strings.HasPrefix(b.Action, "files:") || strings.HasPrefix(b.Action, "open:file:") {
			return theme.Tones["amber"]
		}
		return theme.Tones["cyan"]
	case desktop.KindInfo, desktop.KindTool:
		return theme.Tones["ink"]
	}
	return theme.Tones["violet"]
}

func (app *ShellApp) symbol(hdc uintptr, r rect, name string, tone theme.Tone, radius int32) {
	c := canvas{hdc}
	c.grad2(r, radius, 140, argb(tone.From, 255), argb(tone.To, 255))
	c.stroke(rect{r.Left, r.Top, r.Right, r.Top + r.height()/2}, radius, argb(0xFFFFFF, 160), 1) // inset highlight
	in := r.width() * 23 / 40
	c.drawIcon(name, rect{r.Left + (r.width()-in)/2, r.Top + (r.height()-in)/2, r.Left + (r.width()-in)/2 + in, r.Top + (r.height()-in)/2 + in}, argb(tone.Icon, 255), 1.7)
}

func (app *ShellApp) card(hdc uintptr, r rect, radius int32, hovered bool) {
	c := canvas{hdc}
	if hovered {
		c.shadow(r, radius, app.s(10), app.s(24), 0, hexa(theme.ShadowCard))
	} else {
		c.shadow(r, radius, app.s(3), app.s(8), 0, hexa(0x4A407310))
	}
	c.gradient(r, radius, 135, []uintptr{hexa(theme.CardFrom), hexa(theme.CardTo)}, []float32{0, 1})
	border := argb(0xFFFFFF, 255)
	if hovered {
		border = argb(0xC3A5FF, 255)
	}
	c.stroke(r, radius, border, 1)
}

func (app *ShellApp) drawBlock(hdc uintptr, b desktop.Block, r rect, hovered bool) {
	pad := app.s(15)
	if b.Kind == desktop.KindUser {
		c := canvas{hdc}
		c.grad2(r, app.s(16), 110, argb(0xEEE7FF, 255), argb(0xF5F1FF, 255))
		c.stroke(r, app.s(16), argb(0xE0D1FF, 255), 1)
		text(hdc, app.font(12, 400), theme.Text, rect{r.Left + pad, r.Top + app.s(11), r.Right - pad, r.Bottom}, b.Body, wrapFlags)
		return
	}
	if b.Kind == desktop.KindCode {
		c := canvas{hdc}
		c.round(r, app.s(14), argb(0xFBFAFF, 255))
		c.stroke(r, app.s(14), hexa(theme.Line), 1)
	} else {
		app.card(hdc, r, app.s(16), hovered)
	}
	inner := rect{r.Left + pad, r.Top + pad, r.Right - pad, r.Bottom - pad}
	if icon := app.blockIcon(b); icon != "" {
		app.symbol(hdc, rect{inner.Left, inner.Top, inner.Left + app.s(30), inner.Top + app.s(30)}, icon, app.blockTone(b), app.s(10))
		inner.Left += app.s(44)
	}
	if t := blockTitle(b); t != "" {
		color := uint32(theme.Text)
		switch b.Kind {
		case desktop.KindAssistant, desktop.KindResult:
			color = theme.Brand
		case desktop.KindError:
			color = theme.ErrorText
		}
		th := measure(hdc, app.font(12, 700), inner.width(), t, wrapFlags)
		text(hdc, app.font(12, 700), color, rect{inner.Left, inner.Top, inner.Right, inner.Top + th}, t, wrapFlags)
		inner.Top += th + app.s(5)
	}
	color := uint32(theme.Text)
	switch b.Kind {
	case desktop.KindInfo, desktop.KindResult, desktop.KindTool:
		color = theme.Muted
	case desktop.KindError:
		color = theme.ErrorText
	}
	text(hdc, app.blockFont(b), color, inner, b.Body, wrapFlags)
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

func (app *ShellApp) chatModeFor(v desktop.View) chatMode {
	switch {
	case app.chatExpanded || v.Tab == desktop.TabChat:
		return chatOverlay
	case v.ChatOpen:
		return chatPanel
	}
	return chatHidden
}

func (app *ShellApp) paint(target uintptr) {
	var cr rect
	procGetClientRect.Call(app.handle(), uintptr(unsafe.Pointer(&cr)))
	w, h := cr.width(), cr.height()
	if w <= 0 || h <= 0 {
		return
	}
	if !app.ensureBackbuffer(target, w, h) {
		return
	}
	app.render(app.backDC, cr, app.ctl.View())
	procGdiFlush.Call()
	procBitBlt.Call(target, 0, 0, uintptr(w), uintptr(h), app.backDC, 0, 0, srcCopy)
	app.placeEdit()
	app.lastPaint = time.Now()
	app.updateTimer()
}

// render draws one frame of v into memDC (a 32-bit DIB section).
func (app *ShellApp) render(memDC uintptr, cr rect, v desktop.View) {
	w, h := cr.width(), cr.height()
	procSetBkMode.Call(memDC, bkTransparent)
	c := canvas{memDC}

	app.view = v
	if key := app.promptKeyOf(v.Prompt); key != app.promptKey {
		app.promptKey, app.promptAt = key, time.Now()
	}
	app.updateTimer()
	placeholder := v.Placeholder
	mode := app.chatModeFor(v)
	if mode != chatHidden {
		placeholder = "Întreab-o pe Ilaria…"
	}
	if placeholder != app.placeholder && app.edit != 0 {
		app.placeholder = placeholder
		procSendMessageW.Call(uintptr(app.edit), emSetCueBanner, 1, uintptr(unsafe.Pointer(utf16Ptr(placeholder))))
	}
	app.hits = app.hits[:0]

	// Measure what depends on content: the prompt and the chat panel.
	in := layoutInput{expanded: app.expanded, chat: mode}
	l0 := computeLayout(w, h, app.s, in)
	if v.Prompt != nil {
		in.promptH = app.promptHeight(memDC, v.Prompt, l0.content.width()-app.s(32))
	}
	if mode == chatPanel {
		_, in.chatH = app.chatContentHeight(memDC, v.Chat, l0.omni.width()-app.s(38))
	}
	l := computeLayout(w, h, app.s, in)
	app.layout = l
	app.drawWallpaper(memDC, w, h, l, mode)

	if l.showTop {
		app.paintCapsule(memDC, l.capsule, v)
		app.paintPills(memDC, l.pills, v)
	}
	app.paintMain(memDC, l, v)
	if l.showDeck {
		app.paintDeck(memDC, l.deck)
	}
	if mode == chatOverlay {
		c.shadow(l.overlay, app.s(24), app.s(20), app.s(90), 0, hexa(theme.ShadowOverlay))
		c.round(l.overlay, app.s(24), hexa(theme.OverlayBg))
		c.stroke(l.overlay, app.s(24), argb(0xFFFFFF, 255), 1)
	}
	if mode != chatHidden {
		app.paintChat(memDC, l.chat, v, mode)
	}
	app.paintOmnibar(memDC, l, v, mode)
}

// wallpaper caches the static background (gradient, ambient light, glass
// arcs) per window size; it only changes on resize or DPI change.
type wallpaper struct {
	dc, bmp, old uintptr
	key          wallKey
	w, h         int32 // bitmap size (down-sampled)
}

// wallKey captures everything the static layer depends on.
type wallKey struct {
	w, h                         int32
	expanded, overlay, deck, top bool
}

func (app *ShellApp) dropWallpaper() {
	if wp := app.wall; wp.dc != 0 {
		procSelectObject.Call(wp.dc, wp.old)
		procDeleteObject.Call(wp.bmp)
		procDeleteDC.Call(wp.dc)
	}
	app.wall = wallpaper{}
}

// wallScale is the down-sampling factor of the cached static layer. Its
// content (background, ambient light, arcs, soft shadows) is blurry by
// design, so a quarter-resolution layer looks the same and uses 1/16 of the
// memory of a full-screen bitmap.
const wallScale = 4

func (app *ShellApp) drawWallpaper(target uintptr, w, h int32, l layout, mode chatMode) {
	key := wallKey{w, h, app.expanded, mode == chatOverlay, l.showDeck, l.showTop}
	if app.wall.dc == 0 || app.wall.key != key {
		app.dropWallpaper()
		sw, sh := (w+wallScale-1)/wallScale, (h+wallScale-1)/wallScale
		dc, _, _ := procCreateCompatibleDC.Call(target)
		bi := bitmapInfoHeader{Size: 40, Width: sw, Height: -sh, Planes: 1, BitCount: 32}
		var bits uintptr
		bmp, _, _ := procCreateDIBSection.Call(target, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
		if dc == 0 || bmp == 0 {
			return
		}
		old, _, _ := procSelectObject.Call(dc, bmp)
		release := bindSurface(dc, bits, sw, sh)
		defer release()
		if s, ok := surfaces[dc]; ok {
			procGdipScaleWorldTransform.Call(s.g, f32(1.0/wallScale), f32(1.0/wallScale), 0)
		}
		c := canvas{dc}
		c.round(rect{0, 0, w, h}, 0, argb(theme.Background, 255))
		fw, fh := float32(w), float32(h)
		c.ambient(rect{-w * 20 / 100, h * 30 / 100, -w*20/100 + w*65/100, h*30/100 + h*65/100}, theme.AmbientLilac>>8, uint8(theme.AmbientLilac&0xFF))
		c.ambient(rect{w - w*55/100, 0, w, h * 65 / 100}, theme.AmbientCyan>>8, uint8(theme.AmbientCyan&0xFF))
		c.ambient(rect{w / 2, h / 2, w/2 + w*65/100, h/2 + h*65/100}, theme.AmbientRose>>8, uint8(theme.AmbientRose&0xFF))
		c.arc(0.25*fw, 0.82*fh, 1.1*fw, 0.7*fh, -19, hexa(theme.ArcStroke), hexa(theme.ArcFrom), hexa(theme.ArcTo))
		c.arc(fw, 0.4*fh, 1.1*fw, 0.7*fh, 32, hexa(theme.ArcStroke), hexa(theme.ArcFrom), hexa(theme.ArcTo))
		// Soft shadows of the static glass containers.
		if l.showTop {
			r := l.capsule
			c.shadow(r, r.height()/2, app.s(18), app.s(50), -app.s(18), hexa(theme.ShadowSoft))
			c.shadow(r, r.height()/2, app.s(3), app.s(8), 0, hexa(0x6063960A))
		}
		c.shadow(l.main, app.s(22), app.s(25), app.s(80), -app.s(26), hexa(theme.ShadowMain))
		if l.showDeck {
			c.shadow(l.deck, app.s(17), app.s(18), app.s(50), -app.s(18), hexa(theme.ShadowSoft))
		}
		if mode != chatOverlay {
			app.omniShadow(c, l.omni)
		}
		app.wall = wallpaper{dc: dc, bmp: bmp, old: old, key: key, w: sw, h: sh}
	}
	procSetStretchBltMode.Call(target, 4) // HALFTONE: smooth up-sampling
	procStretchBlt.Call(target, 0, 0, uintptr(w), uintptr(h), app.wall.dc, 0, 0, uintptr(app.wall.w), uintptr(app.wall.h), srcCopy)
	// Crisp glass bodies are drawn at full resolution on top.
	c := canvas{target}
	if l.showTop {
		r := l.capsule
		c.grad2(r, r.height()/2, 120, hexa(theme.CapsuleFrom), hexa(theme.CapsuleTo))
		c.stroke(r, r.height()/2, argb(0xFFFFFF, 255), 1)
	}
	r := l.main
	c.grad2(r, app.s(22), 120, hexa(theme.MainFrom), hexa(theme.MainTo))
	c.stroke(r, app.s(22), argb(0xFFFFFF, 255), 1)
	c.round(l.content, app.s(17), hexa(theme.Content))
	if l.showDeck {
		d := l.deck
		c.grad2(d, app.s(17), 135, hexa(0xFFFFFFDB), hexa(0xFFFFFF80))
		c.stroke(d, app.s(17), argb(0xFFFFFF, 255), 1)
	}
	if mode != chatOverlay {
		app.omniGlass(c, l.omni)
	}
}

func (app *ShellApp) paintCapsule(hdc uintptr, r rect, v desktop.View) {
	c := canvas{hdc} // body and shadow come from the cached static layer
	x := r.Left + app.s(17)
	cy := r.Top + r.height()/2
	sym := rect{x, cy - app.s(35)/2, x + app.s(35), cy - app.s(35)/2 + app.s(35)}
	c.shadow(sym, app.s(11), app.s(3), app.s(7), 0, hexa(0x7C3AED25))
	c.gradient(sym, app.s(11), 145, []uintptr{argb(0xA78BFA, 255), argb(0x7732F5, 255), argb(0x5B21B6, 255)}, []float32{0, 0.65, 1})
	c.stroke(sym, app.s(11), argb(0xA894FF, 255), 1)
	c.drawIcon("brand", rect{sym.Left + app.s(5), sym.Top + app.s(5), sym.Right - app.s(6), sym.Bottom - app.s(6)}, argb(0xFFFFFF, 255), 1.7)
	x = sym.Right + app.s(10)
	sw := app.textWidth(hdc, app.font(20, 700), "Swypik", -0.7)
	app.spaced(hdc, app.font(20, 700), theme.Text, rect{x, r.Top, x + sw + app.s(4), r.Bottom}, "Swypik", dtSingleLine|dtVCenter, -0.7)
	ow := app.textWidth(hdc, app.font(20, 600), "OS", -0.7)
	app.spaced(hdc, app.font(20, 600), theme.Text, rect{x + sw, r.Top, x + sw + ow + app.s(4), r.Bottom}, "OS", dtSingleLine|dtVCenter, -0.7)
	x += sw + ow + app.s(22)
	c.round(rect{x, cy - app.s(16), x + 1, cy + app.s(16)}, 0, hexa(theme.Line))
	x += app.s(23)
	now := time.Now()
	days := [...]string{"Dum", "Lun", "Mar", "Mie", "Joi", "Vin", "Sâm"}
	months := [...]string{"ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sept", "oct", "nov", "dec"}
	text(hdc, app.font(13, 700), theme.Text, rect{x, cy - app.s(17), x + app.s(120), cy + app.s(1)}, now.Format("15:04"), dtSingleLine|dtVCenter)
	text(hdc, app.font(11, 400), theme.Text, rect{x, cy + app.s(2), x + app.s(120), cy + app.s(17)}, fmt.Sprintf("%s %d %s", days[now.Weekday()], now.Day(), months[now.Month()-1]), dtSingleLine|dtVCenter)

	// Right: status, connections button, profile.
	prof := rect{r.Right - app.s(17) - app.s(34), cy - app.s(17), r.Right - app.s(17), cy + app.s(17)}
	c.grad2(prof, app.s(17), 180, argb(0xB4B7CF, 255), argb(0x888DA9, 255))
	c.stroke(prof, app.s(17), argb(0xFFFFFF, 255), 1)
	c.drawIcon("user", rect{prof.Left + app.s(8), prof.Top + app.s(8), prof.Right - app.s(8), prof.Bottom - app.s(8)}, argb(0xFFFFFF, 255), 1.7)
	link := rect{prof.Left - app.s(13) - app.s(35), cy - app.s(17), prof.Left - app.s(13), cy + app.s(18)}
	if app.hover == len(app.hits) {
		c.round(link, app.s(11), argb(theme.Hover, 255))
	}
	c.drawIcon("link", rect{link.Left + app.s(6), link.Top + app.s(6), link.Right - app.s(6), link.Bottom - app.s(6)}, argb(theme.Text, 255), 1.7)
	app.hits = append(app.hits, hit{r: link, kind: hitTab, tab: desktop.TabSettings})
	status := v.Connection
	dot := uint32(theme.StatusDot)
	if v.Busy {
		status, dot = v.BusyLabel+"…", 0xF59E0B
	}
	stw := minI(app.textWidth(hdc, app.font(11, 400), status, 0), app.s(230))
	sx := link.Left - app.s(13) - stw
	c.circle(rect{sx - app.s(13), cy - app.s(3), sx - app.s(7), cy + app.s(3)}, argb(dot, 255))
	text(hdc, app.font(11, 400), theme.Muted, rect{sx, r.Top, link.Left - app.s(13), r.Bottom}, status, lineFlags)
}

func (app *ShellApp) paintPills(hdc uintptr, row rect, v desktop.View) {
	c := canvas{hdc}
	f := app.font(13, 600)
	widths := make([]int32, len(quickPills))
	total := int32(0)
	for i, p := range quickPills {
		widths[i] = maxI(app.s(148), app.s(38)+app.s(22)+app.s(13)+app.textWidth(hdc, f, p.label, 0))
		total += widths[i]
	}
	total += app.s(13) * int32(len(quickPills)-1)
	x := (row.Left + row.Right - total) / 2
	for i, p := range quickPills {
		r := rect{x, row.Top, x + widths[i], row.Bottom}
		hovered := app.hover == len(app.hits)
		active := v.Tab == p.tab
		if hovered {
			r.Top -= app.s(2)
			r.Bottom -= app.s(2)
		}
		color := uint32(theme.Text)
		if active {
			c.shadow(r, app.s(16), app.s(6), app.s(17), 0, hexa(0x7C3AED1A))
			c.grad2(r, app.s(16), 110, argb(0xEEE7FF, 255), hexa(0xF5F1FF70))
			c.stroke(r, app.s(16), argb(0xA78BFA, 255), 1)
			color = 0x6D28D9
		} else {
			if hovered {
				c.shadow(r, app.s(16), app.s(8), app.s(18), 0, hexa(0x7C3AED18))
			} else {
				c.shadow(r, app.s(16), app.s(4), app.s(12), 0, hexa(0x655B9B12))
			}
			c.grad2(r, app.s(16), 140, hexa(theme.PillFrom), hexa(theme.PillTo))
			c.stroke(r, app.s(16), hexa(0xFFFFFFEE), 1)
		}
		lw := app.textWidth(hdc, f, p.label, 0)
		cx := r.Left + (r.width()-(app.s(22)+app.s(13)+lw))/2
		cy := r.Top + r.height()/2
		c.drawIcon(p.icon, rect{cx, cy - app.s(11), cx + app.s(22), cy + app.s(11)}, argb(color, 255), 1.7)
		text(hdc, f, color, rect{cx + app.s(35), r.Top, r.Right, r.Bottom}, p.label, dtSingleLine|dtVCenter)
		app.hits = append(app.hits, hit{r: r, kind: hitTab, tab: p.tab})
		x = r.Right + app.s(13)
	}
}

func (app *ShellApp) paintMain(hdc uintptr, l layout, v desktop.View) {
	c := canvas{hdc}
	// Rail (the window body comes from the cached static layer).
	x := l.rail.Left + (l.rail.width()-app.s(8)-app.s(46))/2
	y := l.rail.Top + app.s(14)
	railButton := func(item navItem, top int32) {
		b := rect{x, top, x + app.s(46), top + app.s(46)}
		hovered := app.hover == len(app.hits)
		color := uint32(theme.RailIcon)
		if v.Tab == item.tab {
			c.grad2(b, app.s(14), 130, argb(0xE6DCFF, 255), hexa(0xEDE7FF70))
			color = theme.Brand
		} else if hovered {
			c.round(b, app.s(14), hexa(0xFFFFFF9C))
		}
		c.drawIcon(item.icon, rect{b.Left + app.s(12), b.Top + app.s(12), b.Right - app.s(12), b.Bottom - app.s(12)}, argb(color, 255), 1.7)
		app.hits = append(app.hits, hit{r: b, kind: hitTab, tab: item.tab})
	}
	for _, item := range railTop {
		railButton(item, y)
		y += app.s(46) + app.s(12)
	}
	c.round(rect{x + app.s(10), y, x + app.s(36), y + 1}, 0, hexa(theme.Line))
	y += app.s(1) + app.s(12)
	for _, item := range railMid {
		railButton(item, y)
		y += app.s(46) + app.s(12)
	}
	railButton(navItem{desktop.TabSettings, "settings", ""}, l.rail.Bottom-app.s(9)-app.s(46))

	// Toolbar.
	tb := l.toolbar
	c.round(rect{tb.Left, tb.Bottom - 1, tb.Right, tb.Bottom}, 0, hexa(0xFFFFFF70))
	cy := tb.Top + tb.height()/2
	right := tb.Right - app.s(19)
	for _, b := range []struct {
		icon string
		kind hitKind
	}{{"fullscreen", hitFullscreen}, {"expand", hitWorkspaceExpand}, {"refresh", hitRefresh}} {
		br := rect{right - app.s(35), cy - app.s(17), right, cy + app.s(18)}
		if app.hover == len(app.hits) {
			c.round(br, app.s(11), argb(theme.Hover, 255))
		}
		c.drawIcon(b.icon, rect{br.Left + app.s(8), br.Top + app.s(8), br.Right - app.s(8), br.Bottom - app.s(8)}, argb(theme.Text, 255), 1.7)
		app.hits = append(app.hits, hit{r: br, kind: b.kind})
		right = br.Left - app.s(14)
	}
	sb := rect{right - app.s(265), cy - app.s(19), right, cy + app.s(19)}
	c.round(sb, app.s(13), hexa(0xFFFFFF48))
	border := argb(0xE5E2F3, 255)
	if app.hover == len(app.hits) {
		border = argb(0xC7AFFF, 255)
	}
	c.stroke(sb, app.s(13), border, 1)
	c.drawIcon("search", rect{sb.Left + app.s(12), cy - app.s(8), sb.Left + app.s(29), cy + app.s(9)}, argb(theme.Muted, 255), 1.7)
	text(hdc, app.font(11, 400), theme.Placeholder, rect{sb.Left + app.s(37), sb.Top, sb.Right - app.s(40), sb.Bottom}, "Caută în indexul tău…", lineFlags)
	kb := rect{sb.Right - app.s(12) - app.s(18), cy - app.s(10), sb.Right - app.s(12), cy + app.s(10)}
	c.stroke(kb, app.s(5), argb(theme.KbdBorder, 255), 1)
	text(hdc, app.font(10, 400), theme.KbdText, kb, "/", dtSingleLine|dtVCenter|dtCenter)
	app.hits = append(app.hits, hit{r: sb, kind: hitSearchBox})
	bx := tb.Left + app.s(19)
	ws := app.textWidth(hdc, app.font(12, 700), "Workspace", 0)
	text(hdc, app.font(12, 700), theme.Text, rect{bx, tb.Top, bx + ws + app.s(2), tb.Bottom}, "Workspace", dtSingleLine|dtVCenter)
	text(hdc, app.font(12, 400), theme.Muted, rect{bx + ws + app.s(11), tb.Top, sb.Left - app.s(14), tb.Bottom}, "/     "+crumb(v), lineFlags)

	app.paintView(hdc, l, v)
	if v.Prompt != nil {
		app.paintPrompt(hdc, l.prompt, v.Prompt)
	}
}

func crumb(v desktop.View) string {
	if v.Tab == desktop.TabHome {
		return "Swypik ecosystem"
	}
	return desktop.TabNames[v.Tab]
}

type bitmapInfoHeader struct {
	Size                         uint32
	Width, Height                int32
	Planes, BitCount             uint16
	Compression, SizeImage       uint32
	XPelsPerMeter, YPelsPerMeter int32
	ClrUsed, ClrImportant        uint32
	_                            [4]byte // one RGBQUAD, unused for 32bpp
}

var (
	procCreateDIBSection  = gdi32.NewProc("CreateDIBSection")
	procStretchBlt        = gdi32.NewProc("StretchBlt")
	procSetStretchBltMode = gdi32.NewProc("SetStretchBltMode")
	procEmptyWorkingSet   = syscall.NewLazyDLL("psapi.dll").NewProc("EmptyWorkingSet")
	procGetCurrentProcess = kernel32.NewProc("GetCurrentProcess")
)

type item struct {
	r     rect
	block *desktop.Block
	tile  *desktop.Tile
	kind  int // 0 block, 1 tile, 2 heading, 3 categories, 4 footnote
}

func (app *ShellApp) visibleTiles(v desktop.View) []desktop.Tile {
	if app.category <= 0 || app.category >= len(desktop.TileCategories) {
		return v.Tiles
	}
	var out []desktop.Tile
	for _, t := range v.Tiles {
		if t.Category == desktop.TileCategories[app.category] {
			out = append(out, t)
		}
	}
	return out
}

func (app *ShellApp) layoutView(hdc uintptr, v desktop.View, colW int32, tiles []desktop.Tile, wide, narrow bool) ([]item, int32) {
	var items []item
	y := int32(0)
	if v.Title != "" {
		h := app.s(18) + app.s(35)
		if v.Subtitle != "" {
			h += app.s(9) + measure(hdc, app.font(12, 400), colW*3/4, v.Subtitle, wrapFlags)
		}
		items = append(items, item{r: rect{0, 0, colW, h}, kind: 2})
		y = h + app.s(21)
	}
	if len(v.Tiles) > 0 {
		items = append(items, item{r: rect{0, y, colW, y + app.s(26)}, kind: 3})
		y += app.s(26) + app.s(19)
		cols := int32(5)
		if narrow {
			cols = 4
		}
		gap, th := app.s(12), app.s(119)
		if wide {
			gap, th = app.s(16), app.s(135)
		}
		tw := (colW - (cols-1)*gap) / cols
		for i := range tiles {
			row, col := int32(i)/cols, int32(i)%cols
			x := col * (tw + gap)
			top := y + row*(th+gap)
			items = append(items, item{r: rect{x, top, x + tw, top + th}, tile: &tiles[i], kind: 1})
		}
		rows := (int32(len(tiles)) + cols - 1) / cols
		y += rows*(th+gap) - gap + app.s(20)
		items = append(items, item{r: rect{0, y, colW, y + app.s(26)}, kind: 4})
		y += app.s(26) + app.s(12)
	}
	for i := range v.Blocks {
		h, x0, x1 := app.blockGeometry(hdc, v.Blocks[i], colW)
		items = append(items, item{r: rect{x0, y, x1, y + h}, block: &v.Blocks[i]})
		y += h + app.s(12)
	}
	return items, y
}

func (app *ShellApp) paintView(hdc uintptr, l layout, v desktop.View) {
	area := l.view
	padX, padY := app.s(27), app.s(25)
	if l.wide {
		padX, padY = app.s(32), app.s(30)
	}
	col := rect{area.Left + padX, area.Top + padY, area.Right - padX, area.Bottom}
	if col.width() < app.s(200) {
		return
	}
	tiles := app.visibleTiles(v)
	items, total := app.layoutView(hdc, v, col.width(), tiles, l.wide, l.narrow)
	tab := v.Tab
	maxOff := maxI(0, total+padY-area.height())
	app.maxScroll[tab] = maxOff
	if app.stick[tab] {
		app.scroll[tab] = maxOff
	}
	app.scroll[tab] = maxI(0, minI(app.scroll[tab], maxOff))
	saved, _, _ := procSaveDC.Call(hdc)
	procIntersectClipRect.Call(hdc, uintptr(area.Left), uintptr(area.Top), uintptr(area.Right), uintptr(area.Bottom))
	off := col.Top - app.scroll[tab]
	for _, it := range items {
		r := rect{col.Left + it.r.Left, off + it.r.Top, col.Left + it.r.Right, off + it.r.Bottom}
		if r.Bottom < area.Top || r.Top > area.Bottom {
			continue
		}
		switch it.kind {
		case 2:
			app.paintHeading(hdc, r, v)
		case 3:
			app.paintCategories(hdc, r)
		case 4:
			c := canvas{hdc}
			c.round(rect{r.Left, r.Top, r.Right, r.Top + 1}, 0, hexa(theme.Line))
			text(hdc, app.font(9, 400), theme.Footnote, rect{r.Left, r.Top + app.s(13), r.Right, r.Bottom}, "Local-first · Ilaria nu execută nimic fără aprobarea ta", dtSingleLine)
			text(hdc, app.font(9, 400), theme.Footnote, rect{r.Left, r.Top + app.s(13), r.Right, r.Bottom}, "Sesiune Swypik locală · Datele tale rămân pe acest dispozitiv", dtSingleLine|0x0002)
		case 1:
			hovered := app.hover == len(app.hits)
			app.hits = append(app.hits, hit{r: clipRect(r, area), kind: hitAction, action: it.tile.Action})
			app.paintTile(hdc, *it.tile, r, hovered)
		default:
			hovered := false
			if it.block.Action != "" {
				hovered = app.hover == len(app.hits)
				app.hits = append(app.hits, hit{r: clipRect(r, area), kind: hitAction, action: it.block.Action})
			}
			app.drawBlock(hdc, *it.block, r, hovered)
		}
	}
	if len(v.Blocks) == 0 && len(v.Tiles) == 0 && v.Empty != "" {
		text(hdc, app.font(13, 400), theme.Muted, rect{area.Left, off + total, area.Right, area.Bottom - app.s(30)}, v.Empty, dtSingleLine|dtVCenter|dtCenter)
	}
	procRestoreDC.Call(hdc, saved)
	if maxOff > 0 {
		c := canvas{hdc}
		track := area.height() - app.s(16)
		thumb := maxI(app.s(28), track*area.height()/(total+padY))
		top := area.Top + app.s(8) + (track-thumb)*app.scroll[tab]/maxOff
		c.round(rect{area.Right - app.s(8), top, area.Right - app.s(4), top + thumb}, app.s(2), argb(0xD7CFEE, 255))
	}
}

func clipRect(r, area rect) rect {
	return rect{r.Left, maxI(r.Top, area.Top), r.Right, minI(r.Bottom, area.Bottom)}
}

func (app *ShellApp) paintHeading(hdc uintptr, r rect, v desktop.View) {
	app.spaced(hdc, app.font(9, 700), theme.Eyebrow, rect{r.Left, r.Top, r.Right, r.Top + app.s(12)}, v.Eyebrow, dtSingleLine|dtEndEllipsis, 2.7)
	ty := r.Top + app.s(18)
	tf := app.font(28, 800)
	// Draw "Title." in the dot colour, then "Title" over it: the dot keeps the
	// exact position the font's kerning and letter-spacing give it.
	tr := rect{r.Left, ty, r.Right, ty + app.s(35)}
	app.spaced(hdc, tf, theme.TitleDot, tr, v.Title+".", dtSingleLine|dtVCenter, -1.1)
	app.spaced(hdc, tf, theme.Text, tr, v.Title, dtSingleLine|dtVCenter, -1.1)
	if v.Subtitle != "" {
		text(hdc, app.font(12, 400), theme.Muted, rect{r.Left, ty + app.s(35) + app.s(9), r.Left + r.width()*3/4, r.Bottom}, v.Subtitle, wrapFlags)
	}
	if v.Tab == desktop.TabHome && !app.layout.narrow {
		c := canvas{hdc}
		label := "Întreab-o pe Ilaria  ↗"
		f := app.font(11, 600)
		bw := app.s(13) + app.s(15) + app.s(8) + app.textWidth(hdc, f, label, 0) + app.s(13)
		b := rect{r.Right - bw, r.Top + app.s(20), r.Right, r.Top + app.s(20) + app.s(36)}
		hovered := app.hover == len(app.hits)
		c.shadow(b, app.s(11), app.s(2), app.s(4), 0, hexa(0x7B6AAB10))
		c.round(b, app.s(11), hexa(0xFFFFFF8C))
		border := argb(0xE6E1F5, 255)
		if hovered {
			border = argb(0xC3A5FF, 255)
		}
		c.stroke(b, app.s(11), border, 1)
		cy := b.Top + b.height()/2
		c.drawIcon("user", rect{b.Left + app.s(13), cy - app.s(7), b.Left + app.s(28), cy + app.s(8)}, argb(theme.Text, 255), 1.7)
		text(hdc, f, theme.Text, rect{b.Left + app.s(36), b.Top, b.Right, b.Bottom}, label, dtSingleLine|dtVCenter)
		app.hits = append(app.hits, hit{r: b, kind: hitAction, action: "chat:open"})
	}
}

func (app *ShellApp) paintCategories(hdc uintptr, r rect) {
	c := canvas{hdc}
	x := r.Left
	f := app.font(10, 400)
	for i, name := range desktop.TileCategories {
		w := app.textWidth(hdc, f, name, 0) + app.s(22)
		b := rect{x, r.Top, x + w, r.Top + app.s(26)}
		color := uint32(theme.Muted)
		if i == app.category {
			c.round(b, app.s(8), argb(0xEDE6FF, 255))
			c.stroke(b, app.s(8), argb(0xE0D1FF, 255), 1)
			color = 0x7034CF
		} else if app.hover == len(app.hits) {
			c.round(b, app.s(8), hexa(0xFFFFFF9C))
		}
		text(hdc, f, color, b, name, dtSingleLine|dtVCenter|dtCenter)
		app.hits = append(app.hits, hit{r: b, kind: hitCategory, index: i})
		x = b.Right + app.s(5)
	}
}

func (app *ShellApp) paintTile(hdc uintptr, t desktop.Tile, r rect, hovered bool) {
	if hovered {
		r.Top -= app.s(3)
		r.Bottom -= app.s(3)
	}
	app.card(hdc, r, app.s(16), hovered)
	pad := app.s(15)
	size := app.s(40)
	if app.layout.wide {
		pad, size = app.s(18), app.s(46)
	}
	tone, ok := theme.Tones[t.Tone]
	if !ok {
		tone = theme.Tones["violet"]
	}
	sym := rect{r.Left + pad, r.Top + pad, r.Left + pad + size, r.Top + pad + size}
	app.symbol(hdc, sym, t.Icon, tone, app.s(13))
	text(hdc, app.font(13, 400), theme.CardArrow, rect{r.Right - app.s(13) - app.s(16), r.Top + app.s(12), r.Right - app.s(8), r.Top + app.s(32)}, "↗", dtSingleLine|dtVCenter)
	ty := sym.Bottom + app.s(12)
	text(hdc, app.font(12, 700), theme.Text, rect{r.Left + pad, ty, r.Right - app.s(8), ty + app.s(17)}, t.Title, lineFlags)
	text(hdc, app.font(9, 400), theme.Muted, rect{r.Left + pad, ty + app.s(20), r.Right - app.s(8), ty + app.s(34)}, t.Subtitle, lineFlags)
}

func (app *ShellApp) promptHeight(hdc uintptr, p *desktop.Prompt, width int32) int32 {
	inner := width - 2*app.s(18)
	h := app.s(14) + measure(hdc, app.font(12, 700), inner, p.Title, wrapFlags) + app.s(10) + app.s(38) + app.s(14)
	if p.Body != "" {
		body := minI(measure(hdc, app.mono(11), inner-2*app.s(12), p.Body, wrapFlags), app.s(220))
		h += body + 2*app.s(10) + app.s(10)
	}
	return h
}

func (app *ShellApp) paintPrompt(hdc uintptr, r rect, p *desktop.Prompt) {
	c := canvas{hdc}
	c.shadow(r, app.s(13), app.s(18), app.s(50), -app.s(18), hexa(theme.ShadowSoft))
	c.round(r, app.s(13), hexa(0xFFFFFFF2))
	border := argb(0xE3D8F8, 255)
	if p.Approval {
		border = argb(0xF2C57C, 255)
	}
	c.stroke(r, app.s(13), border, 1)
	pad := app.s(18)
	inner := rect{r.Left + pad, r.Top + app.s(14), r.Right - pad, r.Bottom - app.s(14)}
	th := measure(hdc, app.font(12, 700), inner.width(), p.Title, wrapFlags)
	text(hdc, app.font(12, 700), theme.Text, rect{inner.Left, inner.Top, inner.Right, inner.Top + th}, p.Title, wrapFlags)
	y := inner.Top + th + app.s(10)
	by := inner.Bottom - app.s(38)
	if p.Body != "" {
		box := rect{inner.Left, y, inner.Right, by - app.s(10)}
		c.round(box, app.s(10), argb(0xF7F5FD, 255))
		c.stroke(box, app.s(10), hexa(theme.Line), 1)
		saved, _, _ := procSaveDC.Call(hdc)
		procIntersectClipRect.Call(hdc, uintptr(box.Left), uintptr(box.Top), uintptr(box.Right), uintptr(box.Bottom))
		text(hdc, app.mono(11), theme.Text, rect{box.Left + app.s(12), box.Top + app.s(10), box.Right - app.s(12), box.Bottom}, p.Body, wrapFlags)
		procRestoreDC.Call(hdc, saved)
	}
	f := app.font(11, 600)
	cw := app.textWidth(hdc, f, p.Confirm, 0) + 2*app.s(16)
	confirm := rect{inner.Left, by, inner.Left + cw, by + app.s(36)}
	rw := app.textWidth(hdc, f, p.Reject, 0) + 2*app.s(16)
	reject := rect{confirm.Right + app.s(10), by, confirm.Right + app.s(10) + rw, by + app.s(36)}
	if app.promptReady() {
		c.shadow(confirm, app.s(11), app.s(4), app.s(10), 0, hexa(0x7C3AED20))
		c.grad2(confirm, app.s(11), 135, argb(0x9560F7, 255), argb(0x7431E5, 255))
		c.stroke(confirm, app.s(11), argb(0x8850EC, 255), 1)
	} else {
		c.round(confirm, app.s(11), argb(0xC9C3DB, 255)) // not yet accepting input
	}
	text(hdc, f, 0xFFFFFF, confirm, p.Confirm, dtSingleLine|dtVCenter|dtCenter)
	c.round(reject, app.s(11), hexa(0xFFFFFF8C))
	c.stroke(reject, app.s(11), argb(0xE6E1F5, 255), 1)
	text(hdc, f, theme.Text, reject, p.Reject, dtSingleLine|dtVCenter|dtCenter)
	app.hits = append(app.hits, hit{r: confirm, kind: hitConfirm}, hit{r: reject, kind: hitReject})
	if p.Approval {
		text(hdc, app.font(10, 400), theme.Muted, rect{reject.Right + app.s(14), by, inner.Right, by + app.s(36)}, "Pasul rulează cu permisiunile tale.", lineFlags)
	}
}

// ---------------------------------------------------------------- chat

func (app *ShellApp) chatEntryHeight(hdc uintptr, b desktop.Block, width int32) int32 {
	return app.s(12) + app.s(15) + measure(hdc, app.font(12, 400), width, b.Body, wrapFlags) + app.s(12)
}

func (app *ShellApp) chatContentHeight(hdc uintptr, entries []desktop.Block, width int32) ([]int32, int32) {
	hs := make([]int32, len(entries))
	total := app.s(8) + app.s(18)
	for i, b := range entries {
		hs[i] = app.chatEntryHeight(hdc, b, width)
		total += hs[i]
	}
	if len(entries) == 0 {
		total += app.s(40)
	}
	return hs, total
}

func (app *ShellApp) paintChat(hdc uintptr, r rect, v desktop.View, mode chatMode) {
	c := canvas{hdc}
	if mode == chatPanel {
		c.shadow(r, app.s(20), app.s(12), app.s(70), 0, hexa(theme.ShadowPanel))
	}
	c.round(r, app.s(20), hexa(theme.PanelBg))
	c.stroke(r, app.s(20), argb(0xFFFFFF, 255), 1)
	header := rect{r.Left, r.Top, r.Right, r.Top + app.s(45)}
	c.round(rect{r.Left, header.Bottom - 1, r.Right, header.Bottom}, 0, hexa(theme.Line))
	lw := app.textWidth(hdc, app.font(11, 700), "ILARIA", 1)
	app.spaced(hdc, app.font(11, 700), theme.Text, rect{r.Left + app.s(19), header.Top, r.Left + app.s(19) + lw + app.s(4), header.Bottom}, "ILARIA", dtSingleLine|dtVCenter, 1)
	sub := "Asistent"
	if v.ChatBusy {
		sub = "scrie…"
	}
	text(hdc, app.font(11, 400), theme.PanelLabel, rect{r.Left + app.s(19) + lw + app.s(7), header.Top, r.Right - app.s(100), header.Bottom}, sub, lineFlags)
	cy := header.Top + header.height()/2
	closeB := rect{r.Right - app.s(12) - app.s(36), cy - app.s(18), r.Right - app.s(12), cy + app.s(18)}
	expB := rect{closeB.Left - app.s(4) - app.s(36), cy - app.s(18), closeB.Left - app.s(4), cy + app.s(18)}
	for _, b := range []struct {
		r    rect
		icon string
		kind hitKind
	}{{expB, "expand", hitChatExpand}, {closeB, "close", hitChatClose}} {
		if app.hover == len(app.hits) {
			c.round(b.r, app.s(10), argb(theme.Hover, 255))
		}
		c.drawIcon(b.icon, rect{b.r.Left + app.s(9), b.r.Top + app.s(9), b.r.Right - app.s(9), b.r.Bottom - app.s(9)}, argb(theme.PinnedHead, 255), 1.7)
		app.hits = append(app.hits, hit{r: b.r, kind: b.kind})
	}
	area := rect{r.Left + app.s(19), header.Bottom + app.s(8), r.Right - app.s(19), r.Bottom - app.s(10)}
	if len(v.Chat) == 0 {
		msg := "Cu ce lucrăm astăzi?"
		if mode == chatOverlay {
			top := area.Top + r.height()*12/100
			text(hdc, app.font(24, 400), theme.Muted, rect{area.Left, top, area.Right, top + app.s(60)}, msg, dtSingleLine|dtVCenter|dtCenter)
		} else {
			text(hdc, app.font(13, 400), theme.Muted, area, msg, dtSingleLine|dtVCenter|dtCenter)
		}
		return
	}
	hs, total := app.chatContentHeight(hdc, v.Chat, area.width())
	maxOff := maxI(0, total-app.s(26)-area.height())
	app.chatMax = maxOff
	if app.chatStick {
		app.chatScroll = maxOff
	}
	app.chatScroll = maxI(0, minI(app.chatScroll, maxOff))
	saved, _, _ := procSaveDC.Call(hdc)
	procIntersectClipRect.Call(hdc, uintptr(area.Left), uintptr(area.Top), uintptr(area.Right), uintptr(area.Bottom))
	y := area.Top - app.chatScroll
	for i, b := range v.Chat {
		e := rect{area.Left, y, area.Right, y + hs[i]}
		y += hs[i]
		if e.Bottom < area.Top || e.Top > area.Bottom {
			continue
		}
		label, lc, bc := "ILARIA", uint32(theme.ChatLabel), uint32(theme.Text)
		switch b.Kind {
		case desktop.KindUser:
			label, lc = "TU", theme.UserLabel
		case desktop.KindError:
			label, lc, bc = "EROARE", theme.ErrorText, theme.ErrorText
		case desktop.KindInfo:
			label, lc, bc = "SWYPIK", theme.UserLabel, theme.Muted
		}
		text(hdc, app.font(10, 700), lc, rect{e.Left, e.Top + app.s(12), e.Right, e.Top + app.s(26)}, label, dtSingleLine)
		text(hdc, app.font(12, 400), bc, rect{e.Left, e.Top + app.s(12) + app.s(15), e.Right, e.Bottom}, b.Body, wrapFlags)
		c.round(rect{e.Left, e.Bottom - 1, e.Right, e.Bottom}, 0, hexa(theme.Line))
	}
	procRestoreDC.Call(hdc, saved)
}

// ---------------------------------------------------------------- omnibar & deck

func (app *ShellApp) paintOmnibar(hdc uintptr, l layout, v desktop.View, mode chatMode) {
	c := canvas{hdc}
	r := l.omni
	rad := app.s(36)
	if mode == chatOverlay {
		app.omniBody(c, r) // the overlay covers the cached one
	}
	if app.focused {
		c.stroke(rect{r.Left - app.s(2), r.Top - app.s(2), r.Right + app.s(2), r.Bottom + app.s(2)}, rad+app.s(2), hexa(0xC7AFFF80), float32(app.s(2)))
	}
	p := app.omniParts(r)
	// Chat (history) and expand buttons with muted icons.
	for _, b := range []struct {
		r    rect
		icon string
		kind hitKind
	}{{p.chatBtn, "chat", hitChatToggle}, {p.expandBtn, "expand", hitChatExpand}} {
		color := uint32(0x77718F)
		if app.hover == len(app.hits) || (b.kind == hitChatToggle && mode != chatHidden) {
			color = theme.Brand
		}
		in := app.s(19)
		cx, cy := b.r.Left+b.r.width()/2, b.r.Top+b.r.height()/2
		c.drawIcon(b.icon, rect{cx - in/2, cy - in/2, cx - in/2 + in, cy - in/2 + in}, argb(color, 255), 1.7)
		app.hits = append(app.hits, hit{r: b.r, kind: b.kind})
	}
	c.stroke(p.kbd, app.s(8), argb(0xDED8EF, 255), 1)
	text(hdc, app.mono(10), theme.KbdText, p.kbd, "Ctrl L", dtSingleLine|dtVCenter|dtCenter)
	stop := v.Live && v.Prompt == nil && mode == chatHidden
	e := p.exec
	c.shadow(e, app.s(17), app.s(4), app.s(12), 0, hexa(0x7C3AED30))
	if stop {
		c.gradient(e, app.s(17), 140, []uintptr{argb(0xFF8A9B, 255), argb(0xE5484D, 255), argb(0xC7303A, 255)}, []float32{0, 0.65, 1})
	} else {
		c.gradient(e, app.s(17), 140, []uintptr{argb(0xA38AFF, 255), argb(0x7737F5, 255), argb(0x6427D3, 255)}, []float32{0, 0.65, 1})
	}
	c.stroke(e, app.s(17), argb(0xA58BFF, 255), 1)
	c.stroke(rect{e.Left + 1, e.Top + 1, e.Right - 1, e.Top + e.height()/2}, app.s(16), hexa(0xFFFFFF66), 1.5)
	icon := "up"
	if stop {
		icon = "stop"
	}
	in := app.s(29)
	c.drawIcon(icon, rect{e.Left + (e.width()-in)/2, e.Top + (e.height()-in)/2, e.Left + (e.width()-in)/2 + in, e.Top + (e.height()-in)/2 + in}, argb(0xFFFFFF, 255), 2)
	app.hits = append(app.hits, hit{r: e, kind: hitSend})
	hint := "Încearcă „deschide agent”, „/index” sau întreab-o pe Ilaria."
	if mode != chatHidden {
		hint = "Enter trimite · Esc închide panoul · /new începe o conversație nouă"
	}
	text(hdc, app.font(9, 400), theme.HintText, l.hint, hint, dtSingleLine|dtCenter|dtEndEllipsis)
}

func (app *ShellApp) omniBody(c canvas, r rect) {
	app.omniShadow(c, r)
	app.omniGlass(c, r)
}

func (app *ShellApp) omniShadow(c canvas, r rect) {
	rad := app.s(36)
	c.shadow(r, rad, app.s(12), app.s(32), 0, hexa(theme.ShadowOmni))
	c.shadow(r, rad, app.s(2), app.s(7), 0, hexa(0x8582BE15))
}

func (app *ShellApp) omniGlass(c canvas, r rect) {
	rad := app.s(36)
	c.grad2(r, rad, 115, hexa(theme.OmniFrom), hexa(theme.OmniTo))
	c.stroke(r, rad, hexa(0xFFFFFF70), float32(app.s(5)))
	c.stroke(r, rad, argb(0xFFFFFF, 255), 1)
}

func (app *ShellApp) paintDeck(hdc uintptr, r rect) {
	c := canvas{hdc} // body and shadow come from the cached static layer
	app.spaced(hdc, app.font(8, 700), theme.PinnedHead, rect{r.Left + app.s(13), r.Top + app.s(11), r.Right, r.Top + app.s(22)}, "FIXATE", dtSingleLine, 2)
	text(hdc, app.font(16, 400), theme.PinnedHead, rect{r.Right - app.s(30), r.Top + app.s(4), r.Right - app.s(13), r.Top + app.s(22)}, "…", dtSingleLine|0x0002)
	x := r.Left + app.s(13)
	f := app.font(10, 400)
	for _, it := range []navItem{{desktop.TabChat, "chat", "Ilaria"}, {desktop.TabAgent, "terminal", "Agent"}, {desktop.TabSearch, "globe", "Căutare"}} {
		w := app.s(8) + app.s(16) + app.s(6) + app.textWidth(hdc, f, it.label, 0) + app.s(8)
		b := rect{x, r.Top + app.s(31), x + w, r.Bottom - app.s(11)}
		bg := hexa(0xFFFFFF88)
		if app.hover == len(app.hits) {
			bg = argb(0xF3EEFF, 255)
		}
		c.round(b, app.s(10), bg)
		c.stroke(b, app.s(10), argb(0xEAE3F6, 255), 1)
		cy := b.Top + b.height()/2
		c.drawIcon(it.icon, rect{b.Left + app.s(8), cy - app.s(8), b.Left + app.s(24), cy + app.s(8)}, argb(theme.Brand, 255), 1.7)
		text(hdc, f, theme.Text, rect{b.Left + app.s(30), b.Top, b.Right, b.Bottom}, it.label, dtSingleLine|dtVCenter)
		action := fmt.Sprintf("tab:%d", it.tab)
		if it.tab == desktop.TabChat {
			action = "chat:open"
		}
		app.hits = append(app.hits, hit{r: b, kind: hitAction, action: action})
		x = b.Right + app.s(6)
	}
}

func solidGDI(rgb uint32) uintptr {
	b, _, _ := procCreateSolidBrush.Call(colorRef(rgb))
	return b
}

// warmSizes lists the (CSS px, weight) pairs the desktop draws with.
var warmSizes = [][2]int32{{8, 700}, {9, 400}, {9, 700}, {10, 400}, {10, 700}, {11, 400}, {11, 600}, {11, 700}, {12, 400}, {12, 700}, {13, 400}, {13, 600}, {13, 700}, {16, 400}, {20, 600}, {20, 700}, {24, 400}, {28, 800}}

// warmFonts rasterizes the glyphs of every face and size on a background
// thread. GDI caches glyphs per process, so the UI thread's first frame no
// longer pays for ClearType rasterization (measured: ~1 s cold).
func (app *ShellApp) warmFonts(dpi int32) {
	faces := map[int32]string{}
	for _, ws := range warmSizes {
		faces[ws[1]], _ = faceFor(int(ws[1]))
	}
	if monoFace == "" {
		monoFace = installedFace("Cascadia Mono", "Consolas")
	}
	mono := monoFace
	type job struct {
		px, weight int32
		face       string
	}
	var jobs []job
	for _, ws := range warmSizes {
		w := ws[1]
		if w != 700 {
			w = 400 // the non-regular weights are separate faces
		}
		jobs = append(jobs, job{ws[0], w, faces[ws[1]]})
	}
	jobs = append(jobs, job{10, 400, mono}, job{11, 400, mono})
	const sample = "AĂÂBCDEFGHIÎJKLMNOPQRSȘTȚUVWXYZ aăâbcdefghiîjklmnopqrsștțuvwxyz 0123456789 .,:;!?…„”/()-·↗"
	workers := resourcepolicy.Default().MaxBackgroundWorkers
	if workers < 1 {
		workers = 1
	}
	if workers > len(jobs) {
		workers = len(jobs)
	}
	done := make(chan struct{}, workers)
	for i := 0; i < workers; i++ {
		go func(part int) {
			defer func() { done <- struct{}{} }()
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			dc, _, _ := procCreateCompatibleDC.Call(0)
			if dc == 0 {
				return
			}
			defer procDeleteDC.Call(dc)
			bi := bitmapInfoHeader{Size: 40, Width: 1600, Height: -64, Planes: 1, BitCount: 32}
			var bits uintptr
			bmp, _, _ := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
			if bmp == 0 {
				return
			}
			old, _, _ := procSelectObject.Call(dc, bmp)
			defer func() { procSelectObject.Call(dc, old); procDeleteObject.Call(bmp) }()
			for j := part; j < len(jobs); j += workers {
				jb := jobs[j]
				f, _, _ := procCreateFontW.Call(uintptr(-jb.px*dpi/96), 0, 0, 0, uintptr(jb.weight), 0, 0, 0, 1, 0, 0, cleartypeQuality, 0, uintptr(unsafe.Pointer(utf16Ptr(jb.face))))
				if f == 0 {
					continue
				}
				prev, _, _ := procSelectObject.Call(dc, f)
				r := rect{0, 0, 1600, 64}
				procDrawTextW.Call(dc, uintptr(unsafe.Pointer(utf16Ptr(sample))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), dtSingleLine|dtNoPrefix)
				procSelectObject.Call(dc, prev)
				procDeleteObject.Call(f)
			}
		}(i)
	}
	started := time.Now()
	// Never hold the interface back for long on a busy machine: show it after
	// at most 1.5 s even if some glyphs are still being rasterized.
	time.AfterFunc(1500*time.Millisecond, func() {
		if !app.ready.Swap(true) {
			app.Notify()
		}
	})
	go func() {
		for i := 0; i < workers; i++ {
			<-done
		}
		app.report(fmt.Sprintf("Fonts warmed in %s", time.Since(started).Round(time.Millisecond)))
		debug.FreeOSMemory() // return start-up garbage (index load, warm-up) to Windows
		app.ready.Store(true)
		app.Notify()
	}()
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
		start := time.Now()
		if app.ready.Load() {
			app.paint(hdc)
		} else {
			var cr rect
			procGetClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&cr)))
			fill := solidGDI(theme.Background)
			procFillRect.Call(hdc, uintptr(unsafe.Pointer(&cr)), fill)
			procDeleteObject.Call(fill)
		}
		if app.paints++; app.paints <= 3 || time.Since(start) > 100*time.Millisecond {
			app.report(fmt.Sprintf("Win32 paint %d took %s", app.paints, time.Since(start).Round(time.Millisecond)))
		}
		procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0
	case wmSize:
		if wParam == 1 { // SIZE_MINIMIZED: nothing to draw; give RAM back to Windows
			app.dropWallpaper()
			app.dropBackbuffer()
			debug.FreeOSMemory()
			proc, _, _ := procGetCurrentProcess.Call()
			procEmptyWorkingSet.Call(proc)
			return 0
		}
		app.invalidate()
		return 0
	case wmSetFocus:
		procSetFocus.Call(uintptr(app.edit))
		return 0
	case wmCommand:
		// EN_SETFOCUS / EN_KILLFOCUS from the input field drive the focus ring.
		switch hiword(wParam) {
		case 0x0100:
			app.focused = true
			app.invalidate()
		case 0x0200:
			app.focused = false
			app.invalidate()
		}
		return 0
	case wmRepaint:
		app.invalidate()
		return 0
	case wmTimer:
		if app.releaseIdleBackbuffer && app.backDC != 0 && !app.view.Live && !app.view.ChatBusy &&
			!app.lastPaint.IsZero() && time.Since(app.lastPaint) >= 2*time.Second {
			app.dropBackbuffer()
		}
		minute := time.Now().Minute()
		if app.view.Live || app.view.ChatBusy || minute != app.minute || (app.view.Prompt != nil && time.Since(app.promptAt) < approvalDwell+400*time.Millisecond) {
			app.minute = minute
			app.invalidate()
		}
		app.updateTimer()
		return 0
	case wmMouseMove:
		x, y := loword(lParam), hiword(lParam)
		hover := -1
		for i := len(app.hits) - 1; i >= 0; i-- { // topmost first
			if app.hits[i].r.contains(x, y) {
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
		pt := point{loword(lParam), hiword(lParam)}
		procScreenToClient.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&pt)))
		app.wheel(pt.X, pt.Y, abs32(delta)*app.s(56)/120, delta > 0)
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
		procSetTextColor.Call(wParam, colorRef(theme.Text))
		procSetBkColor.Call(wParam, colorRef(theme.OmniEdit))
		return app.editBrush
	case wmGetMinMaxInfo:
		info := (*minMaxInfo)(osPointer(lParam))
		info.MinTrackSize = point{app.s(900), app.s(640)}
		return 0
	case wmDpiChanged:
		app.dpi = loword(wParam)
		app.resetFonts()
		suggested := (*rect)(osPointer(lParam))
		procSetWindowPos.Call(uintptr(hwnd), 0, uintptr(suggested.Left), uintptr(suggested.Top), uintptr(suggested.width()), uintptr(suggested.height()), swpNoZOrder|swpNoActivate)
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
	set(34, uint32(colorRef(theme.Background)))
	set(35, uint32(colorRef(theme.Background)))
	set(36, uint32(colorRef(theme.Text)))
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
	defer loadEmbeddedFonts()()
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
	brush, _, _ := procCreateSolidBrush.Call(colorRef(theme.OmniEdit))
	app.editBrush = brush
	defer procDeleteObject.Call(brush)

	edit, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(utf16Ptr("EDIT"))), 0, wsChild|wsVisible|esAutoHScroll, 0, 0, 10, 10, hwnd, 0, instance, 0)
	if edit == 0 {
		procDestroyWindow.Call(hwnd)
		return fmt.Errorf("create input field: %v", err)
	}
	app.edit = syscall.Handle(edit)
	app.warmFonts(app.dpi)
	app.resetFonts()
	defer func() {
		for _, f := range app.fonts {
			procDeleteObject.Call(uintptr(f))
		}
	}()
	procSendMessageW.Call(edit, 0x00C5, 4000, 0) // EM_LIMITTEXT
	app.hwnd.Store(hwnd)
	defer func() {
		app.hwnd.Store(0)
		procKillTimer.Call(hwnd, 1)
		app.timerMS = 0
		app.dropBackbuffer()
		if ok, _, _ := procIsWindow.Call(hwnd); ok != 0 {
			procDestroyWindow.Call(hwnd)
		}
	}()
	app.updateTimer()
	procSetWindowPos.Call(hwnd, 0, uintptr(app.s(80)), uintptr(app.s(60)), uintptr(app.s(1280)), uintptr(app.s(820)), swpNoZOrder|swpNoActivate)
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
