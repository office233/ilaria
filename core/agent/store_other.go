//go:build !linux

package agent

import "fmt"

// The product runs on Linux. Host Windows tests use in-memory stores; do not
// silently substitute weaker locking or permission semantics for production.
func OpenFileStore(string) (DurableStore, error) {
	return nil, fmt.Errorf("durable OS checkpoints require Linux; use the WSL build environment")
}
