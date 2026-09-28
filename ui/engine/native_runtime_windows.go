//go:build windows

package engine

import (
	"fmt"
	"runtime"
	"unicode/utf16"
)

var (
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procIsWindow         = user32.NewProc("IsWindow")
	procUnregisterClassW = user32.NewProc("UnregisterClassW")
	procKillTimer        = user32.NewProc("KillTimer")
	procLoadCursorW      = user32.NewProc("LoadCursorW")
)

func lockNativeThread() func() {
	runtime.LockOSThread()
	return runtime.UnlockOSThread
}

// GetMessageW has three outcomes, not a boolean success/failure contract.
func nativeMessageResult(result uintptr, callErr error) (quit bool, err error) {
	if int32(result) == -1 {
		return false, fmt.Errorf("GetMessageW failed: %v", callErr)
	}
	return result == 0, nil
}

// WM_CHAR delivers UTF-16 code units, including pairs for supplementary runes.
// Invalid sequences are replaced, never stored as invalid UTF-8 in the state.
type utf16Input struct{ high uint16 }

func (d *utf16Input) push(unit uint16) string {
	if unit >= 0xd800 && unit <= 0xdbff {
		previous := d.high
		d.high = unit
		if previous != 0 {
			return "\ufffd"
		}
		return ""
	}
	if unit >= 0xdc00 && unit <= 0xdfff {
		if d.high == 0 {
			return "\ufffd"
		}
		r := utf16.DecodeRune(rune(d.high), rune(unit))
		d.high = 0
		return string(r)
	}
	if d.high != 0 {
		d.high = 0
		return "\ufffd" + string(rune(unit))
	}
	return string(rune(unit))
}
