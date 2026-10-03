//go:build !linux

package effects

import "os"

func readOpenFlags() int { return os.O_RDONLY }
