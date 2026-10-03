package effects

import (
	"os"
	"syscall"
)

func readOpenFlags() int { return os.O_RDONLY | syscall.O_NONBLOCK }
