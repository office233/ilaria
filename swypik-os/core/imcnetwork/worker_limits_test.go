package imcnetwork

import (
	"encoding/json"
	"testing"
)

func TestWorkerLimitsCarryAdmittedBudgetAndLinuxDelegatedRoot(t *testing.T) {
	var config NodeConfig
	raw := []byte(`{"cpu_percent":25,"memory_bytes":1073741824,"linux_delegated_root":"/sys/fs/cgroup/nexus-p2p"}`)
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	limits := workerLimits(config)
	if limits.CPUPercent != 25 || limits.MemoryBytes != 1<<30 || limits.MaxProcesses != 1 || limits.LinuxDelegatedRoot != "/sys/fs/cgroup/nexus-p2p" {
		t.Fatalf("worker limits lost admitted budget or delegated root: %+v", limits)
	}
}

func TestWorkerLimitsWithoutDelegatedRootStayEmpty(t *testing.T) {
	var config NodeConfig
	if err := json.Unmarshal([]byte(`{"cpu_percent":10,"memory_bytes":4096}`), &config); err != nil {
		t.Fatal(err)
	}
	if limits := workerLimits(config); limits.LinuxDelegatedRoot != "" || limits.MaxProcesses != 1 {
		t.Fatalf("unexpected default worker limits: %+v", limits)
	}
}
