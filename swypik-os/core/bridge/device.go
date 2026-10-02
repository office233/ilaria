package bridge

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const adbScanTimeout = 2 * time.Second

// DeviceType classifies the host hardware form factor.
type DeviceType string

const (
	DeviceUnknown DeviceType = "UNKNOWN"
	DeviceDesktop DeviceType = "DESKTOP_PC"
	DeviceLaptop  DeviceType = "LAPTOP_PC"
	DeviceTablet  DeviceType = "TABLET"
	DeviceMobile  DeviceType = "MOBILE_PHONE"
)

// ConnectedMobile describes a smartphone detected via USB ADB or Local Wi-Fi Mesh.
type ConnectedMobile struct {
	ID             string    `json:"id"`
	Model          string    `json:"model"`
	ConnectionType string    `json:"connection_type"` // "USB-ADB" or "P2P-WIFI"
	BatteryPct     int       `json:"battery_pct"`
	SwypikReady    bool      `json:"swypik_ready"`
	LastSeen       time.Time `json:"last_seen"`
}

// DeviceProfile captures real-time host hardware specs and connected peripherals.
type DeviceProfile struct {
	OS              string            `json:"os"`
	Arch            string            `json:"arch"`
	Type            DeviceType        `json:"type"`
	Hostname        string            `json:"hostname"`
	CPUCount        int               `json:"cpu_count"`
	TargetInstall   string            `json:"target_install"`
	ConnectedPhones []ConnectedMobile `json:"connected_phones"`
	ClipboardShared string            `json:"clipboard_shared"`
}

// DeviceBridge coordinates cross-platform device intelligence and telepathy.
type DeviceBridge struct {
	mu      sync.RWMutex
	profile DeviceProfile
}

// NewDeviceBridge detects the current machine and scans for connected smartphones.
func NewDeviceBridge() *DeviceBridge {
	b := &DeviceBridge{}
	b.RefreshProfile()
	return b
}

// RefreshProfile scans OS, CPU architecture, and connected mobile devices.
func (b *DeviceBridge) RefreshProfile() DeviceProfile {
	b.mu.Lock()
	defer b.mu.Unlock()

	hostOS := runtime.GOOS
	arch := runtime.GOARCH
	devType := DeviceUnknown

	phones := b.scanConnectedPhones()

	b.profile = DeviceProfile{
		OS:              hostOS,
		Arch:            arch,
		Type:            devType,
		CPUCount:        runtime.NumCPU(),
		TargetInstall:   fmt.Sprintf("%s-%s", hostOS, arch),
		ConnectedPhones: phones,
		ClipboardShared: "",
	}

	return b.profile
}

// scanConnectedPhones reports Android devices actually observed through ADB.
func (b *DeviceBridge) scanConnectedPhones() []ConnectedMobile {
	phones := make([]ConnectedMobile, 0)

	ctx, cancel := context.WithTimeout(context.Background(), adbScanTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "adb", "devices")
	out, err := cmd.Output()
	if err == nil {
		lines := strings.Split(string(out), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasSuffix(line, "device") && !strings.HasPrefix(line, "List") {
				parts := strings.Fields(line)
				if len(parts) >= 1 {
					deviceID := parts[0]
					phones = append(phones, ConnectedMobile{
						ID:             deviceID,
						Model:          "Android Smartphone (USB-Connected)",
						ConnectionType: "USB-ADB",
						BatteryPct:     -1,
						SwypikReady:    false,
						LastSeen:       time.Now(),
					})
				}
			}
		}
	}

	return phones
}

// GetProfile returns the current device specs.
func (b *DeviceBridge) GetProfile() DeviceProfile {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.profile
}

// SyncClipboard updates the local native clipboard. Cross-device transport is
// not implemented in this package, so the result never claims remote sync.
func (b *DeviceBridge) SyncClipboard(text string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := SetWindowsClipboard(text); err != nil {
		return fmt.Sprintf("[LOCAL CLIPBOARD UPDATE FAILED] %v", err)
	}
	b.profile.ClipboardShared = text
	return "[LOCAL CLIPBOARD UPDATED]"
}

// DeployToMobile fails closed until a verified mobile deployment transport is
// implemented. Detecting a phone is not evidence that anything was installed.
func (b *DeviceBridge) DeployToMobile(phoneID string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, p := range b.profile.ConnectedPhones {
		if p.ID == phoneID {
			return "", fmt.Errorf("mobile deployment is unavailable: no verified transport for %s (%s)", p.Model, p.ConnectionType)
		}
	}

	return "", fmt.Errorf("phone %s not found on bridge", phoneID)
}
