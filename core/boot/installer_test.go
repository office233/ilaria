package boot

import (
	"testing"
)

func TestSystemInstaller(t *testing.T) {
	installer := NewSystemInstaller()

	// 1. Test In-Place Zero-Loss mode
	inPlaceCfg := DeployConfig{
		Platform:         PlatformWindows,
		Mode:             ModeInPlaceTakeover,
		PreserveUserData: true,
	}
	logs, err := installer.ExecuteDeploy(inPlaceCfg)
	if err != nil {
		t.Fatalf("in-place deploy failed: %v", err)
	}
	if len(logs) < 4 {
		t.Errorf("expected at least 4 deployment steps, got %d", len(logs))
	}

	// 2. Test Bare-Metal replacement mode
	bareMetalCfg := DeployConfig{
		Platform:    PlatformBareMetal,
		Mode:        ModeBareMetalOverwrite,
		TargetDrive: "C:",
	}
	installer2 := NewSystemInstaller()
	logs2, err := installer2.ExecuteDeploy(bareMetalCfg)
	if err != nil {
		t.Fatalf("bare-metal deploy failed: %v", err)
	}
	if len(logs2) < 4 {
		t.Errorf("expected at least 4 bare-metal steps, got %d", len(logs2))
	}
}
