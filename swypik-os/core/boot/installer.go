package boot

import (
	"fmt"
	"time"
)

type TargetPlatform string

const (
	PlatformWindows    TargetPlatform = "windows"
	PlatformAndroid    TargetPlatform = "android"
	PlatformBareMetal  TargetPlatform = "bare_metal_x86"
	PlatformBareMobile TargetPlatform = "bare_metal_arm64"
)

type InstallMode string

const (
	ModeInPlaceTakeover    InstallMode = "in_place_preserve_data"
	ModeBareMetalOverwrite InstallMode = "full_os_replacement"
)

type DeployConfig struct {
	Platform         TargetPlatform `json:"platform"`
	Mode             InstallMode    `json:"mode"`
	TargetDrive      string         `json:"target_drive"`
	PreserveUserData bool           `json:"preserve_user_data"`
}
type DeployLog struct {
	Step      string    `json:"step"`
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
}
type SystemInstaller struct{ Logs []DeployLog }

func NewSystemInstaller() *SystemInstaller { return &SystemInstaller{Logs: []DeployLog{}} }

// ExecuteDeploy no longer reports a fictitious installation. This API cannot
// partition, format, install a bootloader or replace an operating system.
func (s *SystemInstaller) ExecuteDeploy(cfg DeployConfig) ([]DeployLog, error) {
	return nil, fmt.Errorf("legacy deployment simulation is disabled: no disks were changed; build and boot the RAM-only ISO using scripts/build-os.sh")
}
