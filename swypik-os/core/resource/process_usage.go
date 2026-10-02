package resource

import (
	"fmt"
	"sync"
	"time"
)

// ProcessUsage is OS-observed process CPU and resident memory. It is not an
// energy estimate, allocator heap size, or a process-tree measurement.
type ProcessUsage struct {
	CPUTime      time.Duration `json:"cpu_time_ns"`
	RSSBytes     uint64        `json:"rss_bytes"`
	PeakRSSBytes uint64        `json:"peak_rss_bytes"`
}

// ProcessSampler holds the identity of an explicitly chosen process. Sampling
// is on demand; creating it starts no goroutine, timer or background polling.
type ProcessSampler struct {
	mu       sync.Mutex
	platform processSampler
	closed   bool
}

func NewProcessSampler(pid int) (*ProcessSampler, error) {
	s, err := openProcessSampler(pid)
	if err != nil {
		return nil, err
	}
	return &ProcessSampler{platform: s}, nil
}

func (s *ProcessSampler) Sample() (ProcessUsage, error) {
	if s == nil {
		return ProcessUsage{}, fmt.Errorf("process sampler is nil")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ProcessUsage{}, fmt.Errorf("process sampler is closed")
	}
	return s.platform.sample()
}
func (s *ProcessSampler) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.platform.close()
}
