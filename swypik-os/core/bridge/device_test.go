package bridge

import (
	"strings"
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
	if profile.Type != DeviceUnknown {
		t.Errorf("CPU architecture was incorrectly treated as form factor: %+v", profile)
	}

	for _, phone := range profile.ConnectedPhones {
		if phone.ID == "p2p-mesh-phone-01" {
			t.Fatal("bridge fabricated a mobile device that was not observed")
		}
		if phone.SwypikReady {
			t.Fatalf("ADB presence was incorrectly treated as Swypik readiness: %+v", phone)
		}
		if msg, err := b.DeployToMobile(phone.ID); err == nil || msg != "" {
			t.Fatalf("unimplemented mobile deploy reported success: msg=%q err=%v", msg, err)
		}
	}

	clipRes := b.SyncClipboard("func HelloWorld() string { return 'Swypik' }")
	if len(clipRes) == 0 {
		t.Error("expected clipboard result")
	}
	if strings.Contains(clipRes, "CROSS-DEVICE") || strings.Contains(clipRes, "SYNCED") {
		t.Fatalf("local clipboard operation overclaimed remote sync: %q", clipRes)
	}
}
