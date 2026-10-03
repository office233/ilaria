package planprocess

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

var ErrKernelLimitsUnavailable = errors.New("strict kernel process limits unavailable")

// Limits describes the mandatory OS-enforced envelope for the supervisor's
// trusted child process tree. CPUPercent is a percentage of the host CPU
// capacity available to the supervisor process; MemoryBytes and MaxProcesses
// are aggregate hard limits for the OS group.
type Limits struct {
	CPUPercent         uint32
	MemoryBytes        uint64
	MaxProcesses       uint32
	LinuxDelegatedRoot string
}

// Group owns one OS resource/containment group. It is intentionally separate
// from Config: Go runtime settings remain cooperative tuning, never authority.
type Group struct {
	mu        sync.Mutex
	platform  *platformGroup
	mechanism string
	closed    bool
}

func OpenGroup(limits Limits) (*Group, error) {
	if limits.CPUPercent < 1 || limits.CPUPercent > 100 || limits.MemoryBytes < 1 || limits.MaxProcesses < 1 {
		return nil, fmt.Errorf("%w: CPU 1..100 percent, positive memory and process limits required", ErrKernelLimitsUnavailable)
	}
	platform, mechanism, err := openPlatformGroup(limits)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrKernelLimitsUnavailable, err)
	}
	return &Group{platform: platform, mechanism: mechanism}, nil
}

func (g *Group) Mechanism() string {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.mechanism
}

func (g *Group) Start(ctx context.Context, config Config) (*Process, error) {
	if g == nil {
		return nil, ErrKernelLimitsUnavailable
	}
	g.mu.Lock()
	if g.closed || g.platform == nil {
		g.mu.Unlock()
		return nil, ErrKernelLimitsUnavailable
	}
	platform := g.platform
	g.mu.Unlock()
	return start(ctx, config, platform)
}

func (g *Group) Close() error {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil
	}
	g.closed = true
	platform := g.platform
	g.platform = nil
	g.mu.Unlock()
	return closePlatformGroup(platform)
}
