//go:build windows
// +build windows

package bridge

import (
	"syscall"
	"unsafe"
)

var (
	user32DLL   = syscall.NewLazyDLL("user32.dll")
	kernel32DLL = syscall.NewLazyDLL("kernel32.dll")
	ntdllDLL    = syscall.NewLazyDLL("ntdll.dll")

	procOpenClipboard              = user32DLL.NewProc("OpenClipboard")
	procCloseClipboard             = user32DLL.NewProc("CloseClipboard")
	procEmptyClipboard             = user32DLL.NewProc("EmptyClipboard")
	procSetClipboardData           = user32DLL.NewProc("SetClipboardData")
	procGetClipboardData           = user32DLL.NewProc("GetClipboardData")
	procIsClipboardFormatAvailable = user32DLL.NewProc("IsClipboardFormatAvailable")

	procGlobalAlloc  = kernel32DLL.NewProc("GlobalAlloc")
	procGlobalFree   = kernel32DLL.NewProc("GlobalFree")
	procGlobalLock   = kernel32DLL.NewProc("GlobalLock")
	procGlobalUnlock = kernel32DLL.NewProc("GlobalUnlock")
	procLstrlenW     = kernel32DLL.NewProc("lstrlenW")

	procRtlMoveMemory = ntdllDLL.NewProc("RtlMoveMemory")
)

const (
	cfUnicodeText = 13
	gmemMoveable  = 0x0002
)

// SetWindowsClipboard writes a string to the native Windows clipboard.
func SetWindowsClipboard(text string) error {
	r, _, err := procOpenClipboard.Call(0)
	if r == 0 {
		return err
	}
	defer procCloseClipboard.Call()

	procEmptyClipboard.Call()

	utf16, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}

	size := uintptr(len(utf16) * 2)
	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, size)
	if hMem == 0 {
		return err
	}

	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		procGlobalFree.Call(hMem)
		return err
	}

	// Copy UTF-16 data to global memory buffer safely via RtlMoveMemory
	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&utf16[0])), size)

	procGlobalUnlock.Call(hMem)

	r, _, err = procSetClipboardData.Call(cfUnicodeText, hMem)
	if r == 0 {
		procGlobalFree.Call(hMem)
		return err
	}

	return nil
}

// GetWindowsClipboard reads a string from the native Windows clipboard.
func GetWindowsClipboard() (string, error) {
	r, _, err := procIsClipboardFormatAvailable.Call(cfUnicodeText)
	if r == 0 {
		return "", nil
	}

	r, _, err = procOpenClipboard.Call(0)
	if r == 0 {
		return "", err
	}
	defer procCloseClipboard.Call()

	hData, _, err := procGetClipboardData.Call(cfUnicodeText)
	if hData == 0 {
		return "", err
	}

	ptr, _, err := procGlobalLock.Call(hData)
	if ptr == 0 {
		return "", err
	}
	defer procGlobalUnlock.Call(hData)

	length, _, _ := procLstrlenW.Call(ptr)
	if length == 0 {
		return "", nil
	}

	buf := make([]uint16, length)
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&buf[0])), ptr, length*2)

	return syscall.UTF16ToString(buf), nil
}
