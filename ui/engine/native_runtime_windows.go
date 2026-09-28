//go:build windows

package engine

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	procRegisterClassExW        = user32.NewProc("RegisterClassExW")
	procUnregisterClassW        = user32.NewProc("UnregisterClassW")
	procCreateWindowExW         = user32.NewProc("CreateWindowExW")
	procDestroyWindow           = user32.NewProc("DestroyWindow")
	procIsWindow                = user32.NewProc("IsWindow")
	procDefWindowProcW          = user32.NewProc("DefWindowProcW")
	procShowWindow              = user32.NewProc("ShowWindow")
	procUpdateWindow            = user32.NewProc("UpdateWindow")
	procGetMessageW             = user32.NewProc("GetMessageW")
	procTranslateMessage        = user32.NewProc("TranslateMessage")
	procDispatchMessageW        = user32.NewProc("DispatchMessageW")
	procPostMessageW            = user32.NewProc("PostMessageW")
	procSendMessageW            = user32.NewProc("SendMessageW")
	procPostQuitMessage         = user32.NewProc("PostQuitMessage")
	procBeginPaint              = user32.NewProc("BeginPaint")
	procEndPaint                = user32.NewProc("EndPaint")
	procGetClientRect           = user32.NewProc("GetClientRect")
	procInvalidateRect          = user32.NewProc("InvalidateRect")
	procSetTimer                = user32.NewProc("SetTimer")
	procKillTimer               = user32.NewProc("KillTimer")
	procLoadCursorW             = user32.NewProc("LoadCursorW")
	procSetCursor               = user32.NewProc("SetCursor")
	procFillRect                = user32.NewProc("FillRect")
	procDrawTextW               = user32.NewProc("DrawTextW")
	procMoveWindow              = user32.NewProc("MoveWindow")
	procSetFocus                = user32.NewProc("SetFocus")
	procGetFocus                = user32.NewProc("GetFocus")
	procGetWindowTextW          = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW    = user32.NewProc("GetWindowTextLengthW")
	procSetWindowTextW          = user32.NewProc("SetWindowTextW")
	procSetWindowPos            = user32.NewProc("SetWindowPos")
	procGetKeyState             = user32.NewProc("GetKeyState")
	procScreenToClient          = user32.NewProc("ScreenToClient")
	procGetDpiForWindow         = user32.NewProc("GetDpiForWindow")
	procSetProcessDpiAwarenessC = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware      = user32.NewProc("SetProcessDPIAware")
	procGetModuleHandleW        = kernel32.NewProc("GetModuleHandleW")
	procShellExecuteW           = shell32.NewProc("ShellExecuteW")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procCreateSolidBrush       = gdi32.NewProc("CreateSolidBrush")
	procCreatePen              = gdi32.NewProc("CreatePen")
	procRoundRect              = gdi32.NewProc("RoundRect")
	procSetBkMode              = gdi32.NewProc("SetBkMode")
	procSetBkColor             = gdi32.NewProc("SetBkColor")
	procSetTextColor           = gdi32.NewProc("SetTextColor")
	procCreateFontW            = gdi32.NewProc("CreateFontW")
	procSaveDC                 = gdi32.NewProc("SaveDC")
	procRestoreDC              = gdi32.NewProc("RestoreDC")
	procIntersectClipRect      = gdi32.NewProc("IntersectClipRect")
)

const (
	wmDestroy        = 0x0002
	wmSize           = 0x0005
	wmSetFocus       = 0x0007
	wmPaint          = 0x000F
	wmClose          = 0x0010
	wmEraseBkgnd     = 0x0014
	wmSetCursor      = 0x0020
	wmGetMinMaxInfo  = 0x0024
	wmSetFont        = 0x0030
	wmKeyDown        = 0x0100
	wmChar           = 0x0102
	wmSysKeyDown     = 0x0104
	wmTimer          = 0x0113
	wmCtlColorEdit   = 0x0133
	wmMouseMove      = 0x0200
	wmLButtonDown    = 0x0201
	wmMouseWheel     = 0x020A
	wmDpiChanged     = 0x02E0
	wmApp            = 0x8000
	wmRepaint        = wmApp + 1
	emSetSel         = 0x00B1
	emSetMargins     = 0x00D3
	emSetCueBanner   = 0x1501
	wsOverlappedWin  = 0x00CF0000
	wsChild          = 0x40000000
	wsVisible        = 0x10000000
	wsClipChildren   = 0x02000000
	esAutoHScroll    = 0x0080
	swShowNormal     = 1
	swShowMaximized  = 3
	srcCopy          = 0x00CC0020
	bkTransparent    = 1
	psSolid          = 0
	htClient         = 1
	vkBack           = 0x08
	vkReturn         = 0x0D
	vkEscape         = 0x1B
	vkPrior          = 0x21
	vkNext           = 0x22
	vkUp             = 0x26
	vkDown           = 0x28
	vkF8             = 0x77
	vkF9             = 0x78
	vkControl        = 0x11
	idcArrow         = 32512
	idcHand          = 32649
	idcIBeam         = 32513
	swpNoZOrder      = 0x0004
	swpNoActivate    = 0x0010
	dtWordBreak      = 0x0010
	dtSingleLine     = 0x0020
	dtVCenter        = 0x0004
	dtCenter         = 0x0001
	dtExpandTabs     = 0x0040
	dtNoClip         = 0x0100
	dtCalcRect       = 0x0400
	dtNoPrefix       = 0x0800
	dtEditControl    = 0x2000
	dtEndEllipsis    = 0x8000
	cleartypeQuality = 5
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     syscall.Handle
}

type rect struct{ Left, Top, Right, Bottom int32 }

func (r rect) contains(x, y int32) bool {
	return x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom
}
func (r rect) width() int32  { return r.Right - r.Left }
func (r rect) height() int32 { return r.Bottom - r.Top }

type paintStruct struct {
	Hdc         syscall.Handle
	Erase       int32
	Paint       rect
	Restore     int32
	IncUpdate   int32
	RgbReserved [32]byte
}

type point struct{ X, Y int32 }

type msg struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type minMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize point
}

// nativeMessageResult interprets GetMessageW's three outcomes.
func nativeMessageResult(result uintptr, callErr error) (quit bool, err error) {
	if int32(result) == -1 {
		return false, fmt.Errorf("GetMessageW failed: %v", callErr)
	}
	return result == 0, nil
}

func utf16Ptr(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(stripNUL(s))
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("")
	}
	return p
}

func stripNUL(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			b := []byte(s)
			for j := range b {
				if b[j] == 0 {
					b[j] = ' '
				}
			}
			return string(b)
		}
	}
	return s
}

func colorRef(hex uint32) uintptr {
	// 0xRRGGBB -> COLORREF 0x00BBGGRR
	return uintptr((hex>>16)&0xFF | (hex & 0xFF00) | (hex&0xFF)<<16)
}

func loword(v uintptr) int32 { return int32(int16(v & 0xFFFF)) }
func hiword(v uintptr) int32 { return int32(int16((v >> 16) & 0xFFFF)) }

func windowText(hwnd syscall.Handle) string {
	n, _, _ := procGetWindowTextLengthW.Call(uintptr(hwnd))
	buf := make([]uint16, n+1)
	procGetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buf[0])), n+1)
	return syscall.UTF16ToString(buf)
}

func setWindowText(hwnd syscall.Handle, s string) {
	procSetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(utf16Ptr(s))))
}
