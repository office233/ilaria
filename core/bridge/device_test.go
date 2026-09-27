package bridge

import (
	"testing"
)

func TestDeviceBridge(t *testing.T) {
	b := NewDeviceBridge()
	if b == nil {
		t.Fatal("expected non-nil DeviceBridge")
	}

	profile := b.GetProfile()
	if profile.OS == "" || profile.Arch == "" {
		t.Errorf("invalid profile: %+v", profile)
	}

	if len(profile.ConnectedPhones) == 0 {
		t.Errorf("expected at least one paired mobile device")
	}

	phoneID := profile.ConnectedPhones[0].ID
	msg, err := b.DeployToMobile(phoneID)
	if err != nil {
		t.Fatalf("failed to deploy to mobile: %v", err)
	}
	if len(msg) == 0 {
		t.Error("expected non-empty deploy message")
	}

	clipRes := b.SyncClipboard("func HelloWorld() string { return 'Swypik' }")
	if len(clipRes) == 0 {
		t.Error("expected clipboard sync confirmation")
	}
}
