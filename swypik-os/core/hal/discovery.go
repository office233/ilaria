package hal

import (
 "context"
 "fmt"
 "os"
 "os/exec"
 "runtime"
 "strconv"
 "strings"
 "time"
)

// A node proves only an endpoint, not the identity or powers of a peripheral.
func describeSerialEndpoint(path string) *DiscoveredDevice {
 return &DiscoveredDevice{
  ID: "dev_uart_" + strings.ReplaceAll(path, "/", "_"),
  Name: "Unclassified serial endpoint (" + path + ")",
  Class: ClassUnknown, Bus: BusUART, Port: path,
  Protocol: "SERIAL_STREAM", DriverStatus: DriverGeneric,
  Capabilities: []string{},
  Metadata: map[string]string{"classification": "unverified", "source": "character_device_node"},
  LastSeen: time.Now(),
 }
}
func (m *Manager) scanUARTPorts() []*DiscoveredDevice {
 devices := []*DiscoveredDevice{}
 if runtime.GOOS == "windows" {
  m.mu.RLock(); defer m.mu.RUnlock()
  for port := 1; port <= 8; port++ {
   if d, ok := m.devices[fmt.Sprintf("dev_uart_com%d", port)]; ok { devices = append(devices, d) }
  }
  return devices
 }
 for _, path := range []string{"/dev/ttyUSB0", "/dev/ttyACM0", "/dev/ttyS0"} {
  if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeCharDevice != 0 {
   devices = append(devices, describeSerialEndpoint(path))
  }
 }
 return devices
}
func (m *Manager) scanCANInterfaces() []*DiscoveredDevice {
 devices := []*DiscoveredDevice{}
 if runtime.GOOS != "linux" { return devices }
 for _, name := range []string{"can0", "vcan0", "slcan0"} {
  if _, err := os.Stat("/sys/class/net/" + name); err == nil {
   devices = append(devices, &DiscoveredDevice{
    ID: "dev_can_endpoint_" + name, Name: "Unclassified CAN endpoint (" + name + ")",
    Class: ClassUnknown, Bus: BusCAN, Port: name, Protocol: "SOCKETCAN",
    DriverStatus: DriverGeneric, Capabilities: []string{},
    Metadata: map[string]string{"classification": "unverified", "source": "network_interface"}, LastSeen: time.Now(),
   })
  }
 }
 return devices
}
// The legacy inventory may query an installed management tool, never infer GPU
// presence from a toolkit path or invent VRAM. No GPU work is executed here.
func (m *Manager) scanGPUDevices(ctx context.Context) []*DiscoveredDevice {
 m.mu.RLock(); existing, ok := m.devices["dev_gpu_nvidia_0"]; m.mu.RUnlock()
 if ok { return []*DiscoveredDevice{existing} }
 ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond); defer cancel()
 output, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits").Output()
 if err != nil || len(output) > 8192 { return nil }
 row := strings.SplitN(strings.TrimSpace(string(output)), "\n", 2)[0]
 columns := strings.Split(row, ",")
 if len(columns) != 3 { return nil }
 memory, err := strconv.Atoi(strings.TrimSpace(columns[1]))
 if err != nil || memory <= 0 { return nil }
 model := strings.TrimSpace(columns[0])
 if model == "" { return nil }
 return []*DiscoveredDevice{{
  ID: "dev_gpu_nvidia_0", Name: model, Class: ClassCompute, Bus: BusPCIe,
  Protocol: "NVIDIA_SMI_INVENTORY", DriverStatus: DriverReady, Capabilities: []string{},
  Metadata: map[string]string{"gpu_vendor": "NVIDIA", "gpu_model": model, "vram_total_mb": strconv.Itoa(memory), "driver_version": strings.TrimSpace(columns[2]), "cuda_version": "unknown", "tflops_fp32": "0", "compute_measurement": "not_tested"},
  LastSeen: time.Now(),
 }}
}
func (m *Manager) GetGPUComputeCapability() (bool, string, int, float64, string) {
 m.mu.RLock(); defer m.mu.RUnlock()
 for _, d := range m.devices {
  if d.Class == ClassCompute && d.Bus == BusPCIe {
   memory, _ := strconv.Atoi(d.Metadata["vram_total_mb"])
   return true, d.Metadata["gpu_model"], memory, 0, d.Metadata["cuda_version"]
  }
 }
 return false, "CPU Fallback", 0, 0, "N/A"
}
