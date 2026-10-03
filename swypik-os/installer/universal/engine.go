package universal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"swypik-os/core/autogenesis"
	"swypik-os/core/devicesynth"
	"swypik-os/core/hal"
	resourcepolicy "swypik-os/core/resource"
	controlkernelcontract "swypik-os/generated/controlkernel"
)

// PlatformType identifies the physical form-factor and operational domain of the host.
type PlatformType string

const (
	PlatformPC        PlatformType = "DESKTOP_OR_SERVER"
	PlatformMobile    PlatformType = "SMARTPHONE_OR_TABLET"
	PlatformVehicle   PlatformType = "AUTOMOTIVE_INFOTAINMENT_ECU"
	PlatformRobot     PlatformType = "ROBOTIC_CONTROLLER_SBC"
	PlatformAppliance PlatformType = "INDUSTRIAL_OR_SMART_MACHINE"
)

// TargetEnvironment captures everything the installer discovers on the target machine.
type TargetEnvironment struct {
	PlatformType        PlatformType                 `json:"platform_type"`
	OS                  string                       `json:"os"`
	Arch                string                       `json:"arch"`
	CPUCount            int                          `json:"cpu_count"`
	DetectedBuses       []string                     `json:"detected_buses"`
	DetectedPeripherals []string                     `json:"detected_peripherals"`
	PreservedUserData   []string                     `json:"preserved_user_data"`
	ProbeTimestamp      time.Time                    `json:"probe_timestamp"`
	HardwareManifest    devicesynth.HardwareManifest `json:"hardware_manifest"`
}

// AdaptationPlan outlines the precise self-configuration steps synthesized by the AI.
type AdaptationPlan struct {
	TargetProfile       string                               `json:"target_profile"`
	ServicesToActivate  []string                             `json:"services_to_activate"`
	DriversToSynthesize []string                             `json:"drivers_to_synthesize"`
	SafetyGovernorMode  string                               `json:"safety_governor_mode"`
	StorageMB           float64                              `json:"storage_mb"`
	EstimatedDeploySec  int                                  `json:"estimated_deploy_sec"`
	ResourcePolicy      controlkernelcontract.ResourcePolicy `json:"resource_policy"`
}

// InstallerEngine probes a target and writes deployment metadata. It does not
// install an operating system.
type InstallerEngine struct {
	mu     sync.RWMutex
	halMgr *hal.Manager
	synth  *autogenesis.Synthesizer
}

// NewInstallerEngine creates the universal adaptive installer.
func NewInstallerEngine(halMgr *hal.Manager, synth *autogenesis.Synthesizer) *InstallerEngine {
	if halMgr == nil {
		halMgr = hal.NewManager()
	}
	if synth == nil {
		synth = autogenesis.NewSynthesizer("")
	}

	return &InstallerEngine{
		halMgr: halMgr,
		synth:  synth,
	}
}

func currentUserHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	if home == "" {
		return "", errors.New("resolve user home: empty path")
	}
	return home, nil
}

// ProbeTarget discovers the hardware environment and classifies the device type.
func (i *InstallerEngine) ProbeTarget(ctx context.Context) (*TargetEnvironment, error) {
	profile, err := i.halMgr.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("HAL probe error: %w", err)
	}
	hardwareManifest, err := hardwareManifestFromHAL(profile)
	if err != nil {
		return nil, fmt.Errorf("hardware manifest: %w", err)
	}

	platform := PlatformPC
	switch profile.HostType {
	case hal.HostVehicle:
		platform = PlatformVehicle
	case hal.HostRobot:
		platform = PlatformRobot
	case hal.HostAppliance:
		platform = PlatformAppliance
	case hal.HostMobile:
		platform = PlatformMobile
	default:
		if runtime.GOOS == "android" {
			platform = PlatformMobile
		}
	}

	buses := make([]string, 0, len(profile.Buses))
	for _, b := range profile.Buses {
		buses = append(buses, string(b))
	}

	peripherals := make([]string, 0, len(profile.Devices))
	for _, d := range profile.Devices {
		peripherals = append(peripherals, fmt.Sprintf("%s (%s on %s)", d.Name, d.Class, d.Bus))
	}

	// User folders a future migration would have to preserve.
	userProfile, err := currentUserHome()
	if err != nil {
		return nil, err
	}
	preserved := []string{
		filepath.Join(userProfile, "Desktop"),
		filepath.Join(userProfile, "Documents"),
		filepath.Join(userProfile, "Downloads"),
		filepath.Join(userProfile, "Pictures"),
	}

	return &TargetEnvironment{
		PlatformType:        platform,
		OS:                  runtime.GOOS,
		Arch:                runtime.GOARCH,
		CPUCount:            runtime.NumCPU(),
		DetectedBuses:       buses,
		DetectedPeripherals: peripherals,
		PreservedUserData:   preserved,
		ProbeTimestamp:      time.Now(),
		HardwareManifest:    hardwareManifest,
	}, nil
}

// GenerateAdaptationPlan designs the tailor-made installation configuration.
func (i *InstallerEngine) GenerateAdaptationPlan(env *TargetEnvironment) *AdaptationPlan {
	plan := &AdaptationPlan{
		ServicesToActivate:  []string{"IlariaNeuralEngine", "SovereignSearch", "SwarmMeshDaemon", "SecurityGuard"},
		DriversToSynthesize: make([]string, 0),
		StorageMB:           18.5,
		EstimatedDeploySec:  3,
		// External callers may construct TargetEnvironment manually. Until a
		// validated manifest-derived policy replaces this value, stay on the
		// smallest existing envelope rather than emitting an all-zero contract.
		ResourcePolicy: resourcepolicy.ForDeviceClass(
			resourcepolicy.ForProfile(resourcepolicy.ProfilePhone),
			devicesynth.PlatformUnknown,
		).Contract(),
	}
	platform := PlatformPC
	if env != nil {
		platform = env.PlatformType
		facts, detectErr := resourcepolicy.DetectHardwareFacts()
		if detectErr != nil {
			facts = resourcepolicy.HardwareFacts{OS: env.OS, Arch: env.Arch, LogicalCPUs: env.CPUCount}
		}
		if selection, selectionErr := resourcepolicy.SelectionFromManifest(env.HardwareManifest, facts); selectionErr == nil {
			plan.ResourcePolicy = selection.Policy.Contract()
		}
	}

	switch platform {
	case PlatformVehicle:
		plan.TargetProfile = "SwypikOS-Vehicle-AutonomousGateway"
		plan.ServicesToActivate = append(plan.ServicesToActivate, "CANBusManager", "ISO15765Diagnostics", "HiveMindMeshCompute", "PhysicalSafetyGovernor")
		plan.DriversToSynthesize = append(plan.DriversToSynthesize, "AutomotiveCAN_ISO11898", "OBD2_DiagnosticReader")
		plan.SafetyGovernorMode = "AUTOMOTIVE_CRITICAL_WATCHDOG"

	case PlatformRobot:
		plan.TargetProfile = "SwypikOS-Robotics-CognitiveController"
		plan.ServicesToActivate = append(plan.ServicesToActivate, "KinematicDispatcher", "UARTDynamixelController", "PhysicalSafetyGovernor", "HiveMindClient")
		plan.DriversToSynthesize = append(plan.DriversToSynthesize, "RoboticArmKinematics_6DoF", "VisualInertialOdometryDriver")
		plan.SafetyGovernorMode = "ROBOTICS_ESTOP_ARMED"

	case PlatformAppliance:
		plan.TargetProfile = "SwypikOS-SmartMachine-IndustrialEdge"
		plan.ServicesToActivate = append(plan.ServicesToActivate, "ModbusRTUGateway", "RelayScheduler", "PowerTelemetryAgent")
		plan.DriversToSynthesize = append(plan.DriversToSynthesize, "Modbus_RTU_Function05", "CurrentSensorReader")
		plan.SafetyGovernorMode = "INDUSTRIAL_THERMAL_INTERLOCK"

	case PlatformMobile:
		plan.TargetProfile = "SwypikOS-Mobile-PureAgentic"
		plan.ServicesToActivate = append(plan.ServicesToActivate, "ApplessOmnibar", "ZeroClickProactiveAgent", "CellularMeshBridge")
		plan.SafetyGovernorMode = "STANDARD_MOBILE_SANDBOX"

	default: // PC
		plan.TargetProfile = "SwypikOS-Desktop-SpatialLuxury"
		plan.ServicesToActivate = append(plan.ServicesToActivate, "LuxuryGPUCompositor", "UniversalDeviceBridge", "SwarmMonetizationEngine")
		plan.SafetyGovernorMode = "WORKSTATION_STANDARD"
	}

	return plan
}

// Deploy writes deployment metadata for the target: driver candidates for
// devices that need one, descriptor files for the user folders and a manifest.
// It installs nothing. No disk is partitioned, no bootloader, kernel or
// service is installed, and the manifest says exactly that.
func (i *InstallerEngine) Deploy(ctx context.Context, targetDir string, env *TargetEnvironment, plan *AdaptationPlan) error {
	if env == nil {
		return errors.New("target environment is required")
	}
	if plan == nil {
		return errors.New("adaptation plan is required")
	}
	i.mu.Lock()
	defer i.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return fmt.Errorf("failed to create target install dir: %w", err)
	}

	candidates := map[string]string{}
	if profile := i.halMgr.GetProfile(); profile != nil {
		for _, dev := range profile.Devices {
			if dev.DriverStatus != hal.DriverNeedsAutogenesis && dev.DriverStatus != "" {
				continue
			}
			driver, err := i.synth.SynthesizeDriver(dev)
			if err != nil {
				candidates[dev.ID] = "FAILED: " + err.Error()
				continue
			}
			candidates[dev.ID] = string(driver.State) + "/" + string(driver.Evidence)
		}
	}

	mapping, err := i.mapUserDataPartitionsInternal(env.PreservedUserData, targetDir)
	if err != nil {
		return fmt.Errorf("failed to describe user folders: %w", err)
	}

	manifest := map[string]interface{}{
		"written_at":        time.Now().Format(time.RFC3339),
		"environment":       env,
		"adaptation_plan":   plan,
		"driver_candidates": candidates,
		"user_folders":      mapping,
		"status":            "METADATA_ONLY",
		"os_installed":      false,
		"not_performed":     []string{"disk partitioning", "filesystem creation", "EFI bootloader", "Secure Boot", "kernel install", "system services", "recovery partition", "boot validation"},
	}

	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal installation manifest: %w", err)
	}

	manifestPath := filepath.Join(targetDir, "swypik_deployment_manifest.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0600); err != nil {
		return fmt.Errorf("failed to write deployment manifest: %w", err)
	}

	return nil
}

// UserDataPartitionMapping describes host user folders. It is an inventory,
// not a migration: nothing is copied, hashed or mounted, so it proves nothing
// about data loss. Counts cover top-level entries only.
type UserDataPartitionMapping struct {
	UserProfilePath    string            `json:"user_profile_path"`
	MappedPartitions   map[string]string `json:"mapped_partitions"` // folder name -> host path
	TopLevelEntries    int               `json:"top_level_entries"`
	TopLevelFileBytes  int64             `json:"top_level_file_bytes"`
	DataLossProtection string            `json:"data_loss_protection"`
	MappedAt           time.Time         `json:"mapped_at"`
}

// dataLossUnverified is the only honest protection level until a migration
// exists that inventories, hashes, backs up and restore-verifies user data.
const dataLossUnverified = "NOT_VERIFIED: descriptors only; no inventory hashes, backup or restore check"

// MapUserDataPartitions writes descriptors for the host user folders without
// reading or changing their contents beyond a top-level listing.
func (i *InstallerEngine) MapUserDataPartitions(userProfilePath string, targetWorkspaceDir string) (*UserDataPartitionMapping, error) {
	i.mu.Lock()
	defer i.mu.Unlock()

	if userProfilePath == "" {
		var err error
		userProfilePath, err = currentUserHome()
		if err != nil {
			return nil, err
		}
	}

	if targetWorkspaceDir == "" {
		targetWorkspaceDir = filepath.Join(userProfilePath, ".swypik", "workspace")
	}

	return i.mapUserDataPartitionsInternal([]string{
		filepath.Join(userProfilePath, "Desktop"),
		filepath.Join(userProfilePath, "Documents"),
		filepath.Join(userProfilePath, "Downloads"),
		filepath.Join(userProfilePath, "Pictures"),
		filepath.Join(userProfilePath, "Videos"),
		filepath.Join(userProfilePath, "Music"),
	}, targetWorkspaceDir)
}

func (i *InstallerEngine) mapUserDataPartitionsInternal(folders []string, targetWorkspaceDir string) (*UserDataPartitionMapping, error) {
	mountsDir := filepath.Join(targetWorkspaceDir, "mnt")
	if err := os.MkdirAll(mountsDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create mounts directory: %w", err)
	}

	mapping := &UserDataPartitionMapping{
		MappedPartitions:   make(map[string]string),
		DataLossProtection: dataLossUnverified,
		MappedAt:           time.Now(),
	}

	for _, srcPath := range folders {
		folderName := filepath.Base(srcPath)
		if mapping.UserProfilePath == "" {
			mapping.UserProfilePath = filepath.Dir(srcPath)
		}

		fi, err := os.Stat(srcPath)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("stat %s: %w", srcPath, err)
		}
		if !fi.IsDir() {
			continue
		}

		entries, err := os.ReadDir(srcPath)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", srcPath, err)
		}
		mapping.MappedPartitions[folderName] = srcPath
		mapping.TopLevelEntries += len(entries)
		for _, e := range entries {
			if !e.Type().IsRegular() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				return nil, fmt.Errorf("stat %s: %w", filepath.Join(srcPath, e.Name()), err)
			}
			mapping.TopLevelFileBytes += info.Size()
		}

		descriptor := fmt.Sprintf("TYPE=DESCRIPTOR_ONLY\nSRC=%s\nMOUNTED=false\nDATA_LOSS_PROTECTION=%s\n", srcPath, dataLossUnverified)
		if err := os.WriteFile(filepath.Join(mountsDir, folderName+".mount"), []byte(descriptor), 0600); err != nil {
			return nil, fmt.Errorf("write descriptor for %s: %w", srcPath, err)
		}
	}

	manifestData, err := json.MarshalIndent(mapping, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal user folder manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(targetWorkspaceDir, "swypik_user_mounts.json"), manifestData, 0600); err != nil {
		return nil, fmt.Errorf("write user folder manifest: %w", err)
	}

	return mapping, nil
}
