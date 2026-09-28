// Package compute reports this device's accelerators and the state of its
// optional contribution to Ilaria training. It never starts GPU work by itself.
// The contribution protocol (job leasing, verification, consent) is specified
// in docs/ILARIA_COMPUTE.md and requires the Ilaria training coordinator.
package compute

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// GPU is one detected accelerator. Values come from the vendor tool; nothing
// is estimated or invented.
type GPU struct {
	Vendor        string `json:"vendor"`
	Name          string `json:"name"`
	MemoryMB      int    `json:"memory_mb"`
	DriverVersion string `json:"driver_version"`
	Utilization   int    `json:"utilization_percent"`
}

// Status is what the desktop shows about compute contribution.
type Status struct {
	GPUs        []GPU  `json:"gpus"`
	DetectError string `json:"detect_error,omitempty"`
	Contribute  bool   `json:"contribute"`
	Coordinator string `json:"coordinator,omitempty"`
	// Active is true only when a real coordinator session is running. This
	// build contains no coordinator client, so it is always false.
	Active bool   `json:"active"`
	Reason string `json:"reason"`
}

// parseNvidiaSMI parses --query-gpu=name,memory.total,driver_version,utilization.gpu
// in csv,noheader,nounits format; one line per GPU.
func parseNvidiaSMI(out string) ([]GPU, error) {
	var gpus []GPU
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		cols := strings.Split(line, ",")
		if len(cols) != 4 {
			return nil, fmt.Errorf("unexpected nvidia-smi output")
		}
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		mem, err := strconv.Atoi(cols[1])
		if err != nil || mem <= 0 || cols[0] == "" {
			return nil, fmt.Errorf("unexpected nvidia-smi output")
		}
		util, _ := strconv.Atoi(cols[3])
		gpus = append(gpus, GPU{Vendor: "NVIDIA", Name: cols[0], MemoryMB: mem, DriverVersion: cols[2], Utilization: util})
	}
	return gpus, nil
}

// DetectGPUs queries nvidia-smi. A missing tool means "no NVIDIA driver
// found", not an error: other vendors are not detected by this build.
func DetectGPUs(ctx context.Context) ([]GPU, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name,memory.total,driver_version,utilization.gpu", "--format=csv,noheader,nounits")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		if _, lookErr := exec.LookPath("nvidia-smi"); lookErr != nil {
			return nil, nil
		}
		return nil, fmt.Errorf("nvidia-smi failed: %w", err)
	}
	if len(out) > 64*1024 {
		return nil, fmt.Errorf("nvidia-smi output too large")
	}
	return parseNvidiaSMI(string(out))
}

// Inspect builds the status shown to the user.
func Inspect(ctx context.Context, contribute bool, coordinator string) Status {
	s := Status{Contribute: contribute, Coordinator: coordinator}
	gpus, err := DetectGPUs(ctx)
	s.GPUs = gpus
	if err != nil {
		s.DetectError = err.Error()
	}
	switch {
	case !contribute:
		s.Reason = "Contribution is off. Nothing runs on this GPU for Ilaria."
	case coordinator == "":
		s.Reason = "Contribution is enabled, but no Ilaria training coordinator is configured."
	default:
		s.Reason = "The coordinator protocol is not implemented in this build; no work is accepted."
	}
	return s
}
