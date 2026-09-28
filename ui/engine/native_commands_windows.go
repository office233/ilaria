//go:build windows

package engine

import (
	"strings"
	"unsafe"

	"swypik-os/core/search"
	"swypik-os/ui/desktop"
)

// ---------------------------------------------------------------- input

func (app *ShellApp) submit(textIn string) {
	app.ctl.Submit(textIn)
	// Home may navigate or start a chat; follow the tab the controller chose.
	switch tab := app.ctl.Tab(); tab {
	case desktop.TabChat, desktop.TabAgent:
		app.stick[tab] = true
	case desktop.TabSearch:
		app.scroll[tab] = 0 // results are listed first
	}
	app.invalidate()
}

func (app *ShellApp) confirm() {
	if app.promptReady() {
		app.ctl.Confirm()
		app.stick[app.view.Tab] = true
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
	app.ctl.SetTab(t)
	procSetFocus.Call(uintptr(app.edit))
	app.invalidate()
}

func (app *ShellApp) click(x, y int32) {
	for _, h := range app.hits {
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
		case hitSearchPill:
			app.setTab(desktop.TabSearch)
		case hitConfirm:
			app.confirm()
		case hitReject:
			app.reject()
		case hitSend:
			if app.view.Live && app.view.Prompt == nil {
				app.ctl.Cancel()
			} else {
				t := windowText(app.edit)
				setWindowText(app.edit, "")
				app.submit(t)
			}
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
		if app.view.Prompt != nil {
			app.reject()
		} else if app.view.Live {
			app.ctl.Cancel()
		}
	case m.WParam == vkF8:
		if !repeat {
			app.confirm()
		}
	case m.WParam == vkF9:
		if !repeat {
			app.reject()
		}
	case ctrl && m.WParam >= '1' && m.WParam < '1'+uintptr(desktop.TabCount):
		app.setTab(desktop.Tab(m.WParam - '1'))
	case ctrl && m.WParam == 'L':
		procSetFocus.Call(uintptr(app.edit))
		procSendMessageW.Call(uintptr(app.edit), emSetSel, 0, ^uintptr(0))
	case ctrl && m.WParam == 'A' && m.Hwnd == app.edit:
		procSendMessageW.Call(uintptr(app.edit), emSetSel, 0, ^uintptr(0))
	case m.WParam == vkPrior || m.WParam == vkNext:
		step := app.layout.body.height() * 4 / 5
		app.scrollBy(step, m.WParam == vkPrior)
	default:
		return false
	}
	return true
}

func (app *ShellApp) scrollBy(pixels int32, up bool) {
	tab := app.view.Tab
	if up {
		app.scroll[tab] -= pixels
		app.stick[tab] = false
	} else {
		app.scroll[tab] += pixels
		if app.scroll[tab] >= app.maxScroll[tab] {
			app.scroll[tab] = app.maxScroll[tab]
			app.stick[tab] = tab == desktop.TabChat || tab == desktop.TabAgent
		}
	}
	app.invalidate()
}

func (app *ShellApp) placeEdit() {
	var cr rect
	procGetClientRect.Call(app.handle(), uintptr(unsafe.Pointer(&cr)))
	l := computeLayout(cr.width(), cr.height(), app.s, 0)
	procMoveWindow.Call(uintptr(app.edit), uintptr(l.edit.Left), uintptr(l.edit.Top), uintptr(l.edit.width()), uintptr(l.edit.height()), 1)
}
