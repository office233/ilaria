package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/devicesynth"
	"swypik-os/core/effects"
	"swypik-os/core/resource"
	"swypik-os/core/supervisor"
	"swypik-os/internal/planprocess"
)

// Host configuration is authority input. It never travels to the Swyp guest.
type configuration struct {
	Version            uint64                        `json:"version"`
	Journal            string                        `json:"journal"`
	LedgerDirectory    string                        `json:"ledger_directory"`
	SwypExecutable     string                        `json:"swyp_executable"`
	VerifierExecutable string                        `json:"verifier_executable"`
	TrustRegistry      string                        `json:"trust_registry"`
	ExecutorID         string                        `json:"executor_id"`
	ExecutorCredential string                        `json:"executor_credential"`
	VerifierID         string                        `json:"verifier_id"`
	VerifierCredential string                        `json:"verifier_credential"`
	SignerKeyID        string                        `json:"signer_key_id"`
	PrivateKey         ed25519.PrivateKey            `json:"private_key"`
	Roots              map[string]string             `json:"roots"`
	Profile            string                        `json:"profile"`
	DeviceClass        string                        `json:"device_class"`
	CPUTimeMS          int64                         `json:"cpu_time_ms"`
	RSSLimitBytes      uint64                        `json:"rss_limit_bytes"`
	SampleIntervalMS   int64                         `json:"sample_interval_ms"`
	KernelCPUPercent   uint32                        `json:"kernel_cpu_percent"`
	KernelMemoryBytes  uint64                        `json:"kernel_memory_limit_bytes"`
	KernelMaxProcesses uint32                        `json:"kernel_max_processes"`
	LinuxCgroupRoot    string                        `json:"linux_cgroup_root,omitempty"`
	Continuation       *continuationConfiguration    `json:"continuation,omitempty"`
	Plans              []configuredPlan              `json:"plans"`
	ContinuationPolicy supervisor.ContinuationPolicy `json:"-"`
}

type continuationConfiguration struct {
	Mode             string `json:"mode"`
	Directory        string `json:"directory,omitempty"`
	KeyFile          string `json:"key_file,omitempty"`
	KeyID            string `json:"key_id,omitempty"`
	MaxEnvelopeBytes int    `json:"max_envelope_bytes,omitempty"`
}

type configuredPlan struct {
	ID                string             `json:"id"`
	TaskID            string             `json:"task_id"`
	RunID             string             `json:"run_id"`
	Source            string             `json:"source"`
	Entry             string             `json:"entry"`
	Arguments         []string           `json:"arguments"`
	Deadline          string             `json:"deadline"`
	MaxEffects        uint64             `json:"max_effects"`
	MaxReadBytes      int64              `json:"max_read_bytes"`
	Fuel              int                `json:"fuel"`
	MaxReturnedBytes  int                `json:"max_returned_bytes"`
	WallTimeMS        int64              `json:"wall_time_ms"`
	Scopes            []supervisor.Scope `json:"scopes"`
	ExpectedValueHash string             `json:"expected_value_hash,omitempty"`
}

func loadConfiguration(path string) (configuration, resource.Policy, error) {
	var config configuration
	if !filepath.IsAbs(path) {
		return config, resource.Policy{}, fmt.Errorf("host configuration path must be absolute")
	}
	f, err := os.Open(path)
	if err != nil {
		return config, resource.Policy{}, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, effects.MaxMessageBytes+1))
	if err != nil {
		return config, resource.Policy{}, err
	}
	if err := decodeFrame(raw, &config); err != nil {
		return config, resource.Policy{}, fmt.Errorf("invalid host configuration: %w", err)
	}
	policy, err := validateConfiguration(config)
	if err != nil {
		return config, resource.Policy{}, err
	}
	config.ContinuationPolicy, err = loadContinuationPolicy(config)
	if err != nil {
		return config, resource.Policy{}, err
	}
	return config, policy, nil
}

func validateConfiguration(c configuration) (resource.Policy, error) {
	if (c.Version != 2 && c.Version != 3) || c.ExecutorID == "" || c.VerifierID == "" || c.ExecutorID == c.VerifierID || c.ExecutorCredential == "" || c.VerifierCredential == "" || c.ExecutorCredential == c.VerifierCredential {
		return resource.Policy{}, fmt.Errorf("explicit independent host identities and host configuration version 2 or 3 required")
	}
	if c.Version == 2 && c.Continuation != nil {
		return resource.Policy{}, fmt.Errorf("continuation persistence requires host configuration version 3")
	}
	if c.Version == 3 {
		if c.Continuation == nil {
			return resource.Policy{}, fmt.Errorf("version 3 requires an explicit continuation data/key policy")
		}
		switch c.Continuation.Mode {
		case "disabled":
			if c.Continuation.Directory != "" || c.Continuation.KeyFile != "" || c.Continuation.KeyID != "" || c.Continuation.MaxEnvelopeBytes != 0 {
				return resource.Policy{}, fmt.Errorf("disabled continuation policy must not carry persistence authority")
			}
		case supervisor.ContinuationModeAES256GCM:
			if !filepath.IsAbs(c.Continuation.Directory) || !filepath.IsAbs(c.Continuation.KeyFile) || c.Continuation.KeyID == "" ||
				c.Continuation.MaxEnvelopeBytes < 1 || c.Continuation.MaxEnvelopeBytes > supervisor.MaxContinuationEnvelopeBytes ||
				c.Continuation.MaxEnvelopeBytes > planprocess.MaxLineBytes {
				return resource.Policy{}, fmt.Errorf("authenticated continuation policy requires absolute data/key paths, key id and envelope size within the current %d-byte process transport limit", planprocess.MaxLineBytes)
			}
		default:
			return resource.Policy{}, fmt.Errorf("unsupported continuation persistence mode")
		}
	}
	if err := effects.ValidateSigningIdentity(c.SignerKeyID, c.PrivateKey); err != nil {
		return resource.Policy{}, err
	}
	for _, path := range []string{c.Journal, c.LedgerDirectory, c.SwypExecutable, c.VerifierExecutable, c.TrustRegistry} {
		if !filepath.IsAbs(path) {
			return resource.Policy{}, fmt.Errorf("host paths must be absolute")
		}
	}
	for name, path := range c.Roots {
		if name == "" || !filepath.IsAbs(path) {
			return resource.Policy{}, fmt.Errorf("read roots require explicit aliases and absolute paths")
		}
	}
	if c.Profile != "phone" && c.Profile != "balanced" && c.Profile != "performance" {
		return resource.Policy{}, fmt.Errorf("unknown resource profile")
	}
	class := devicesynth.PlatformClass(c.DeviceClass)
	switch class {
	case devicesynth.PlatformUnknown, devicesynth.PlatformWorkstation, devicesynth.PlatformMobile, devicesynth.PlatformAutomotive, devicesynth.PlatformRobot, devicesynth.PlatformAppliance, devicesynth.PlatformEmbedded:
	default:
		return resource.Policy{}, fmt.Errorf("unknown device class")
	}
	policy := resource.ForDeviceClass(resource.ForProfile(resource.Profile(c.Profile)), class)
	if c.CPUTimeMS < 1 || c.CPUTimeMS > 60000 || c.SampleIntervalMS < 10 || c.SampleIntervalMS > 1000 || c.RSSLimitBytes < 1<<20 || c.RSSLimitBytes > uint64(policy.MemoryLimitMB)<<20 {
		return resource.Policy{}, fmt.Errorf("process limits must tighten the resource profile; CPU 1..60000ms, sampling 10..1000ms")
	}
	if c.KernelCPUPercent < 1 || c.KernelCPUPercent > uint32(policy.MaxBackgroundCPUPercent) ||
		c.KernelMemoryBytes < 1<<20 || c.KernelMemoryBytes > uint64(policy.MemoryLimitMB)<<20 ||
		c.KernelMaxProcesses < 1 || c.KernelMaxProcesses > 256 {
		return resource.Policy{}, fmt.Errorf("strict kernel limits must tighten the resource profile; CPU must be within the effective profile ceiling, with positive memory and 1..256 processes")
	}
	if c.RSSLimitBytes > c.KernelMemoryBytes {
		return resource.Policy{}, fmt.Errorf("sampled RSS ceiling cannot exceed the strict process-group memory limit")
	}
	if runtime.GOOS == "linux" {
		if !filepath.IsAbs(c.LinuxCgroupRoot) || filepath.Clean(c.LinuxCgroupRoot) == "/sys/fs/cgroup" {
			return resource.Policy{}, fmt.Errorf("Linux requires an explicit delegated non-global cgroup v2 root")
		}
	} else if c.LinuxCgroupRoot != "" {
		return resource.Policy{}, fmt.Errorf("linux_cgroup_root is valid only on Linux")
	}
	if len(c.Plans) < 1 || len(c.Plans) > 64 {
		return resource.Policy{}, fmt.Errorf("configure 1..64 plans")
	}
	ids, tasks, runs := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, p := range c.Plans {
		deadline, err := time.Parse(time.RFC3339Nano, p.Deadline)
		if err != nil || deadline.IsZero() || p.ID == "" || ids[p.ID] || tasks[p.TaskID] || runs[p.RunID] || !filepath.IsAbs(p.Source) || p.Entry == "" || len(p.Arguments) > 64 || p.MaxEffects < 1 || p.MaxEffects > supervisor.MaxPlanEffects || p.MaxReadBytes < 0 || p.MaxReadBytes > 64<<20 || p.Fuel < 1 || p.Fuel > 1000000 || p.MaxReturnedBytes < 0 || p.MaxReturnedBytes > 1<<20 || p.WallTimeMS < 1 || p.WallTimeMS > 60000 || len(p.Scopes) > 64 {
			return resource.Policy{}, fmt.Errorf("invalid or duplicate configured plan")
		}
		if p.ExpectedValueHash != "" && !validHash(p.ExpectedValueHash) {
			return resource.Policy{}, fmt.Errorf("expected value hash must be canonical SHA256")
		}
		for _, arg := range p.Arguments {
			if len(arg) > 1<<20 {
				return resource.Policy{}, fmt.Errorf("typed argument too large")
			}
		}
		ids[p.ID], tasks[p.TaskID], runs[p.RunID] = true, true, true
	}
	return policy, nil
}

func loadContinuationPolicy(c configuration) (supervisor.ContinuationPolicy, error) {
	if c.Version != 3 || c.Continuation == nil || c.Continuation.Mode == "disabled" {
		return supervisor.ContinuationPolicy{}, nil
	}
	info, err := os.Lstat(c.Continuation.KeyFile)
	if err != nil {
		return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation key file unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation key file must be a regular non-symlink file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation key file must not be accessible by group/other")
	}
	file, err := os.Open(c.Continuation.KeyFile)
	if err != nil {
		return supervisor.ContinuationPolicy{}, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, 33))
	closeErr := file.Close()
	if readErr != nil {
		return supervisor.ContinuationPolicy{}, readErr
	}
	if closeErr != nil {
		return supervisor.ContinuationPolicy{}, closeErr
	}
	if len(raw) != 32 {
		return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation key file must contain exactly 32 raw bytes")
	}
	var key [32]byte
	copy(key[:], raw)
	for i := range raw {
		raw[i] = 0
	}
	if info, err := os.Lstat(c.Continuation.Directory); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation data directory must be a real directory")
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			return supervisor.ContinuationPolicy{}, fmt.Errorf("continuation data directory must not be accessible by group/other")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return supervisor.ContinuationPolicy{}, err
	}
	return supervisor.ContinuationPolicy{Enabled: true, Mode: c.Continuation.Mode, Directory: c.Continuation.Directory,
		KeyID: c.Continuation.KeyID, Key: key, MaxEnvelopeBytes: c.Continuation.MaxEnvelopeBytes}, nil
}

type hostAuthentication struct {
	executorID, verifierID     string
	executorHash, verifierHash [32]byte
}

func (a hostAuthentication) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	hash := sha256.Sum256([]byte(credential))
	if subtle.ConstantTimeCompare(hash[:], a.executorHash[:]) != 1 {
		return controlkernel.ExecutorPrincipal{}, controlkernel.ErrExecutorUnauthorized
	}
	return controlkernel.ExecutorPrincipal{ID: a.executorID}, nil
}
func (a hostAuthentication) AuthenticateVerifier(credential string) (controlkernel.VerifierPrincipal, error) {
	hash := sha256.Sum256([]byte(credential))
	if subtle.ConstantTimeCompare(hash[:], a.verifierHash[:]) != 1 {
		return controlkernel.VerifierPrincipal{}, controlkernel.ErrVerifierUnauthorized
	}
	return controlkernel.VerifierPrincipal{ID: a.verifierID}, nil
}
