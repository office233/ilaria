//go:build !windows

package security

func checkDebuggerAttached() bool {
	return false
}
