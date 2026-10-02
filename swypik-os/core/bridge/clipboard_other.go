//go:build !windows
// +build !windows

package bridge

import "fmt"

func SetWindowsClipboard(text string) error {
	return fmt.Errorf("native clipboard update is unavailable on this platform")
}

func GetWindowsClipboard() (string, error) {
	return "", nil
}
