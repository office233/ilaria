//go:build !windows
// +build !windows

package bridge

func SetWindowsClipboard(text string) error {
	return nil
}

func GetWindowsClipboard() (string, error) {
	return "", nil
}
