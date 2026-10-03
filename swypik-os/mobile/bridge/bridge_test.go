package bridge

import (
	"strings"
	"testing"
)

func TestMobileBridge(t *testing.T) {
	t.Setenv("SWYPIK_STATE_DIR", t.TempDir())
	b := NewMobileBridge()
	defer b.Close()
	if b == nil {
		t.Fatal("expected non-nil MobileBridge")
	}

	res := b.DispatchOmnibar("create server.go api")
	if len(res) == 0 {
		t.Error("expected non-empty response from DispatchOmnibar")
	}

	searchJSON := b.QuerySearch("Golang 2026")
	if !strings.Contains(searchJSON, "Golang") && !strings.Contains(searchJSON, "sources") {
		t.Errorf("unexpected search output: %s", searchJSON)
	}

	swarmJSON := b.GetSwarmStatus()
	if !strings.Contains(swarmJSON, "local_tflops") && !strings.Contains(swarmJSON, "mesh_nodes") {
		t.Errorf("unexpected swarm output: %s", swarmJSON)
	}
}
