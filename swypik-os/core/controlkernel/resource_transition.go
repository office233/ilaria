package controlkernel

import (
	"fmt"

	resourcepolicy "swypik-os/core/resource"
)

// ResourceTransitionSink adapts the runtime Resource Governor to the durable
// Control Kernel journal. It deliberately carries only coarse budget/reason
// state, never user content or stable hardware identifiers.
type ResourceTransitionSink struct {
	kernel *Kernel
}

func NewResourceTransitionSink(kernel *Kernel) *ResourceTransitionSink {
	return &ResourceTransitionSink{kernel: kernel}
}

func (s *ResourceTransitionSink) RecordResourceTransition(transition resourcepolicy.Transition) error {
	if s == nil || s.kernel == nil {
		return fmt.Errorf("resource transition sink requires control kernel")
	}
	_, err := s.kernel.RecordResourceState(ResourceState{
		Profile:                  string(transition.Profile),
		DeviceClass:              transition.DeviceClass,
		BaseBackgroundCPUPercent: uint64(transition.Base.MaxCPUPercent),
		BaseBackgroundGPUPercent: uint64(transition.Base.MaxGPUPercent),
		BaseBackgroundWorkers:    uint64(transition.Base.MaxWorkers),
		MaxBackgroundCPUPercent:  uint64(transition.Current.MaxCPUPercent),
		MaxBackgroundGPUPercent:  uint64(transition.Current.MaxGPUPercent),
		MaxBackgroundWorkers:     uint64(transition.Current.MaxWorkers),
		Paused:                   transition.Current.Paused,
		Preempt:                  transition.Current.Preempt,
		Reasons:                  append([]string(nil), transition.Current.Reasons...),
	})
	return err
}
