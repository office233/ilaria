//go:build windows

package security

import (
	"runtime"
	"syscall"
	"unsafe"
)

var (
	kernel32DLL                    = syscall.NewLazyDLL("kernel32.dll")
	procIsDebuggerPresent          = kernel32DLL.NewProc("IsDebuggerPresent")
	procCheckRemoteDebuggerPresent = kernel32DLL.NewProc("CheckRemoteDebuggerPresent")
	procGetCurrentProcess          = kernel32DLL.NewProc("GetCurrentProcess")
)

func checkDebuggerAttached() bool {
	if procIsDebuggerPresent.Find() != nil {
		return false
	}
	r, _, _ := procIsDebuggerPresent.Call()
	if r != 0 {
		return true
	}

	if procCheckRemoteDebuggerPresent.Find() == nil && procGetCurrentProcess.Find() == nil {
		var isDebuggerPresent int32
		hProcess, _, _ := procGetCurrentProcess.Call()
		procCheckRemoteDebuggerPresent.Call(hProcess, uintptr(unsafe.Pointer(&isDebuggerPresent)))
		ret := isDebuggerPresent != 0
		runtime.KeepAlive(&isDebuggerPresent)
		return ret
	}
	return false
}
