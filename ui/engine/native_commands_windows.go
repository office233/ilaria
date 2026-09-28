//go:build windows

package engine

import (
	"strings"
	"unsafe"

	"swypik-os/core/search"
	"swypik-os/ui/desktop"
)

var (
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procGetWindowRect     = user32.NewProc("GetWindowRect")
	procMonitorFromWindow = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW   = user32.NewProc("GetMonitorInfoW")
)

// submit routes typed text: to Ilaria while her panel is open, otherwise to
// the current view (the home view navigates or starts a chat).
func (app *ShellApp) submit(textIn string) {
	if strings.TrimSpace(textIn) == "" {
		return
	}
	app.view = app.ctl.View() // route by the current state, not the last frame
	if app.chatModeFor(app.view) != chatHidden {
		app.ctl.SubmitChat(textIn)
	} else {
		app.ctl.Submit(textIn)
		switch tab := app.ctl.Tab(); tab {
		case desktop.TabAgent:
			app.stick[tab] = true
		case desktop.TabSearch, desktop.TabFiles:
			app.scroll[tab] = 0
		}
	}
	app.chatStick = true
	app.invalidate()
}

func (app *ShellApp) confirm() {
	if app.promptReady() {
		app.ctl.Confirm()
		app.stick[app.view.Tab] = app.view.Tab == desktop.TabAgent
		app.invalidate()
	}
}

func (app *ShellApp) reject() {
	if app.view.Prompt != nil {
		app.ctl.Reject()
		app.invalidate()
	}
}

func (app *ShellApp) setTab(t desktop.Tab) {
	if t == desktop.TabChat {
		app.ctl.OpenChat()
	} else {
		app.ctl.SetTab(t)
	}
	procSetFocus.Call(uintptr(app.edit))
	app.invalidate()
}

func (app *ShellApp) closeChat() {
	app.chatExpanded = false
	app.ctl.CloseChat()
}

func (app *ShellApp) click(x, y int32) {
	for i := len(app.hits) - 1; i >= 0; i-- { // topmost first
		h := app.hits[i]
		if !h.r.contains(x, y) {
			continue
		}
		switch h.kind {
		case hitTab:
			app.setTab(h.tab)
		case hitAction:
			ext := app.ctl.Activate(h.action)
			switch {
			case strings.HasPrefix(ext, "fill:"):
				t := strings.TrimPrefix(ext, "fill:")
				setWindowText(app.edit, t)
				n := uintptr(len([]rune(t)))
				procSendMessageW.Call(uintptr(app.edit), emSetSel, n, n)
			case ext != "":
				app.openExternal(ext)
			case strings.HasPrefix(h.action, "files:"):
				app.scroll[desktop.TabFiles] = 0
			}
		case hitConfirm:
			app.confirm()
		case hitReject:
			app.reject()
		case hitSend:
			if app.view.Live && app.view.Prompt == nil && app.chatModeFor(app.view) == chatHidden {
				app.ctl.Cancel()
			} else {
				t := windowText(app.edit)
				setWindowText(app.edit, "")
				app.submit(t)
			}
		case hitSearchBox:
			app.setTab(desktop.TabSearch)
		case hitCategory:
			app.category = h.index
		case hitChatToggle:
			if app.chatModeFor(app.view) != chatHidden {
				app.closeChat()
			} else {
				app.ctl.OpenChat()
			}
		case hitChatExpand:
			if app.chatModeFor(app.view) == chatHidden {
				app.ctl.OpenChat()
			}
			app.chatExpanded = !app.chatExpanded
			if !app.chatExpanded && app.view.Tab == desktop.TabChat {
				app.ctl.SetTab(desktop.TabHome)
				app.ctl.OpenChat()
			}
		case hitChatClose:
			app.closeChat()
		case hitWorkspaceExpand:
			app.expanded = !app.expanded
		case hitFullscreen:
			app.toggleFullscreen()
		case hitRefresh:
			app.ctl.Refresh()
		}
		break
	}
	procSetFocus.Call(uintptr(app.edit))
	app.invalidate()
}

// openExternal opens web results in the user's browser and reveals local files
// in Explorer. Files are never opened with their association, which could run
// scripts or installers.
func (app *ShellApp) openExternal(action string) {
	target := strings.TrimPrefix(action, "open:")
	verb := utf16Ptr("open")
	switch {
	case strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "http://"):
		procShellExecuteW.Call(app.handle(), uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(utf16Ptr(target))), 0, 0, swShowNormal)
	case strings.HasPrefix(target, "file:"):
		if path, ok := search.FilePath(target); ok && !strings.ContainsRune(path, '"') {
			procShellExecuteW.Call(app.handle(), uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(utf16Ptr("explorer.exe"))), uintptr(unsafe.Pointer(utf16Ptr(`/select,"`+path+`"`))), 0, swShowNormal)
		}
	}
}

// toggleFullscreen switches between the framed window and a borderless window
// covering the monitor, like the original desktop's full-screen button.
func (app *ShellApp) toggleFullscreen() {
	hwnd := app.handle()
	const gwlStyle = ^uintptr(15) // GWL_STYLE = -16
	if !app.fullscreen {
		style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlStyle)
		app.savedStyle = style
		procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&app.savedRect)))
		monitor, _, _ := procMonitorFromWindow.Call(hwnd, 2) // MONITOR_DEFAULTTONEAREST
		info := struct {
			Size          uint32
			Monitor, Work rect
			Flags         uint32
		}{}
		info.Size = uint32(unsafe.Sizeof(info))
		procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&info)))
		procSetWindowLongPtrW.Call(hwnd, gwlStyle, (style&^wsOverlappedWin)|0x80000000) // WS_POPUP
		m := info.Monitor
		procSetWindowPos.Call(hwnd, 0, uintptr(m.Left), uintptr(m.Top), uintptr(m.width()), uintptr(m.height()), 0x0020|swpNoZOrder) // SWP_FRAMECHANGED
		app.fullscreen = true
		return
	}
	procSetWindowLongPtrW.Call(hwnd, gwlStyle, app.savedStyle)
	r := app.savedRect
	procSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top), uintptr(r.width()), uintptr(r.height()), 0x0020|swpNoZOrder)
	app.fullscreen = false
}

func keyDown(vk uintptr) bool {
	state, _, _ := procGetKeyState.Call(vk)
	return state&0x8000 != 0
}

// preTranslate handles keys before the edit control sees them.
func (app *ShellApp) preTranslate(m *msg) bool {
	if m.Message != wmKeyDown && m.Message != wmSysKeyDown {
		return false
	}
	repeat := m.LParam&(1<<30) != 0
	ctrl := keyDown(vkControl)
	if m.WParam == vkEscape {
		app.view = app.ctl.View()
	}
	switch {
	case m.WParam == vkReturn && m.Hwnd == app.edit:
		t := windowText(app.edit)
		setWindowText(app.edit, "")
		app.submit(t)
	case (m.WParam == vkUp || m.WParam == vkDown) && m.Hwnd == app.edit:
		var t string
		if m.WParam == vkUp {
			t = app.ctl.HistoryPrev()
		} else {
			t = app.ctl.HistoryNext()
		}
		setWindowText(app.edit, t)
		n := uintptr(len([]rune(t)))
		procSendMessageW.Call(uintptr(app.edit), emSetSel, n, n)
	case m.WParam == vkEscape:
		switch {
		case app.view.Prompt != nil:
			app.reject()
		case app.fullscreen:
			app.toggleFullscreen()
		case app.chatModeFor(app.view) != chatHidden:
			app.closeChat()
		case app.view.Live:
			app.ctl.Cancel()
		}
		app.invalidate()
	case m.WParam == vkF8:
		if !repeat {
			app.confirm()
		}
	case m.WParam == vkF9:
		if !repeat {
			app.reject()
		}
	case m.WParam == 0x7A: // F11
		if !repeat {
			app.toggleFullscreen()
		}
	case ctrl && m.WParam >= '1' && m.WParam < '1'+uintptr(desktop.TabCount):
		app.setTab(desktop.Tab(m.WParam - '1'))
	case ctrl && m.WParam == 'L':
		procSetFocus.Call(uintptr(app.edit))
		procSendMessageW.Call(uintptr(app.edit), emSetSel, 0, ^uintptr(0))
	case ctrl && m.WParam == 'A' && m.Hwnd == app.edit:
		procSendMessageW.Call(uintptr(app.edit), emSetSel, 0, ^uintptr(0))
	case m.WParam == vkPrior || m.WParam == vkNext:
		step := app.layout.view.height() * 4 / 5
		app.scrollView(step, m.WParam == vkPrior)
	default:
		return false
	}
	return true
}

// wheel scrolls whichever surface is under the pointer.
func (app *ShellApp) wheel(x, y, pixels int32, up bool) {
	if app.chatModeFor(app.view) != chatHidden && app.layout.chat.contains(x, y) {
		if up {
			app.chatScroll -= pixels
			app.chatStick = false
		} else {
			app.chatScroll += pixels
			app.chatStick = app.chatScroll >= app.chatMax
		}
		app.invalidate()
		return
	}
	app.scrollView(pixels, up)
}

func (app *ShellApp) scrollView(pixels int32, up bool) {
	tab := app.view.Tab
	if up {
		app.scroll[tab] -= pixels
		app.stick[tab] = false
	} else {
		app.scroll[tab] += pixels
		if app.scroll[tab] >= app.maxScroll[tab] {
			app.scroll[tab] = app.maxScroll[tab]
			app.stick[tab] = tab == desktop.TabAgent
		}
	}
	app.invalidate()
}

// placeEdit keeps the native input field inside the omnibar capsule, which
// moves when the chat panel expands to full screen.
func (app *ShellApp) placeEdit() {
	if app.edit == 0 || app.layout.omni.width() <= 0 {
		return
	}
	r := app.omniParts(app.layout.omni).input
	if r != app.editRect {
		app.editRect = r
		procMoveWindow.Call(uintptr(app.edit), uintptr(r.Left), uintptr(r.Top), uintptr(r.width()), uintptr(r.height()), 1)
	}
}
