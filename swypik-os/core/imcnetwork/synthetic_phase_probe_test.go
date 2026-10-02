package imcnetwork

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyntheticPhaseProbeDefaultOff(t *testing.T) {
	probe, err := checkedSyntheticPhaseProbe(NodeConfig{})
	if err != nil || probe != nil {
		t.Fatalf("default probe: %v/%v", probe, err)
	}
	raw, err := json.Marshal(networkRequest{Operation: "network-propose"})
	if err != nil || strings.Contains(string(raw), "phase_probe") {
		t.Fatal("default request gained diagnostic authority", string(raw), err)
	}
}

func TestSyntheticPhaseProbeAdmissionBeforeEffects(t *testing.T) {
	state := monitorState(t)
	for _, invalid := range []NodeConfig{
		{ID: "proposer", State: state, SyntheticPhaseHoldMS: 1},
		{ID: "issuer", State: state, SyntheticPhaseProbe: true},
		{ID: "other", State: state, SyntheticPhaseProbe: true},
		{ID: "proposer", State: state, Resume: true, SyntheticPhaseProbe: true},
		{ID: "proposer", State: "relative-state", SyntheticPhaseProbe: true},
		{ID: "proposer", State: state, SyntheticPhaseProbe: true, SyntheticPhaseHoldMS: -1},
		{ID: "proposer", State: state, SyntheticPhaseProbe: true, SyntheticPhaseHoldMS: 1001},
	} {
		if _, err := checkedSyntheticPhaseProbe(invalid); err == nil {
			t.Fatalf("unsafe diagnostic admitted: %+v", invalid)
		}
		// No executable, keys or socket endpoint are supplied. The public wrapper
		// must still report diagnostic admission, before allocation can occur.
		if err := RunNode(context.Background(), invalid, NodeSecrets{}); err == nil || !strings.Contains(err.Error(), "synthetic phase") {
			t.Fatalf("public admission: %v", err)
		}
	}
	valid := NodeConfig{ID: "proposer", State: state, SyntheticPhaseProbe: true, SyntheticPhaseHoldMS: 1000}
	probe, err := checkedSyntheticPhaseProbe(valid)
	if err != nil || probe.Path != filepath.Join(state, "synthetic-phase.json") || probe.HoldMS != 1000 {
		t.Fatalf("valid probe: %v/%v", probe, err)
	}
	if err := os.WriteFile(probe.Path, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := checkedSyntheticPhaseProbe(valid); err == nil {
		t.Fatal("existing marker was admitted for overwrite")
	}
	if raw, err := os.ReadFile(probe.Path); err != nil || string(raw) != "existing" {
		t.Fatal("existing marker changed")
	}
}

func TestSyntheticPhaseProbeConsentAndSymlinkRefusal(t *testing.T) {
	state := monitorState(t)
	config := NodeConfig{ID: "proposer", State: state, SyntheticPhaseProbe: true}
	if err := save(filepath.Join(state, "consent.json"), []byte(`{"opt_in":true,"epoch":2,"scope":"synthetic-public-v1","purpose":"local-network-training"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := checkedSyntheticPhaseProbe(config); err == nil {
		t.Fatal("changed epoch granted diagnostic authority")
	}
	if err := save(filepath.Join(state, "consent.json"), []byte(monitorHealthyConsent)); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "foreign")
	if err := os.WriteFile(target, []byte("protected"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(state, "synthetic-phase.json")); err != nil {
		t.Skipf("host symlink privilege unavailable: %v", err)
	}
	if _, err := checkedSyntheticPhaseProbe(config); err == nil {
		t.Fatal("marker symlink admitted")
	}
	if raw, err := os.ReadFile(target); err != nil || string(raw) != "protected" {
		t.Fatal("foreign target changed")
	}
}
