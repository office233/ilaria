package compute

import (
	"context"
	"testing"
)

func TestParseNvidiaSMI(t *testing.T) {
	gpus, err := parseNvidiaSMI("NVIDIA GeForce GTX 1660 Ti, 6144, 560.94, 7\nNVIDIA RTX 4090, 24564, 560.94, 0\n")
	if err != nil || len(gpus) != 2 || gpus[0].MemoryMB != 6144 || gpus[1].Name != "NVIDIA RTX 4090" || gpus[0].Utilization != 7 {
		t.Fatalf("%+v %v", gpus, err)
	}
	for _, bad := range []string{"x", "GPU, notanumber, 1, 0", ", 100, 1, 0"} {
		if _, err := parseNvidiaSMI(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestInspectNeverClaimsActiveWork(t *testing.T) {
	for _, tc := range []struct {
		contribute  bool
		coordinator string
	}{{false, ""}, {true, ""}, {true, "https://coordinator.example"}} {
		s := Inspect(context.Background(), tc.contribute, tc.coordinator)
		if s.Active || s.Reason == "" {
			t.Fatalf("%+v", s)
		}
	}
}
