//go:build !windows && !linux

package resource

import "fmt"

type processSampler struct{}

func openProcessSampler(int) (processSampler, error) {
	return processSampler{}, fmt.Errorf("process measurement unsupported on this platform")
}
func (processSampler) sample() (ProcessUsage, error) {
	return ProcessUsage{}, fmt.Errorf("process measurement unsupported on this platform")
}
func (processSampler) close() error { return nil }
