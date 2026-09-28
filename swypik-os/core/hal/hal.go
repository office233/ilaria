package hal

import (
 "context"
 "fmt"
 "os"
 "runtime"
 "sync"
 "time"
)

type DeviceClass string
const (
 ClassUnknown DeviceClass = "UNKNOWN"
 ClassCompute DeviceClass = "COMPUTE"
 ClassVehicle DeviceClass = "VEHICLE"
 ClassRobot DeviceClass = "ROBOT"
 ClassAppliance DeviceClass = "APPLIANCE"
 ClassSensor DeviceClass = "SENSOR"
 ClassActuator DeviceClass = "ACTUATOR"
 ClassNetwork DeviceClass = "NETWORK"
)
type BusType string
const (
 BusCAN BusType = "CAN_BUS"
 BusOBD2 BusType = "OBD2_ISO15765"
 BusUART BusType = "UART_SERIAL"
 BusI2C BusType = "I2C_BUS"
 BusSPI BusType = "SPI_BUS"
 BusGPIO BusType = "GPIO_PINS"
 BusUSB BusType = "USB_PERIPHERAL"
 BusModbus BusType = "MODBUS_RS485"
 BusEthernet BusType = "ETHERNET_IP"
 BusBLE BusType = "BLUETOOTH_LE"
 BusPCIe BusType = "PCIE_BUS"
)
type DriverStatus string
const (
 DriverReady DriverStatus = "READY"
 DriverNeedsAutogenesis DriverStatus = "NEEDS_AUTOGENESIS"
 DriverGeneric DriverStatus = "GENERIC_FALLBACK"
 DriverFailed DriverStatus = "FAILED"
)
type DiscoveredDevice struct {
 ID string `json:"id"`
 Name string `json:"name"`
 Class DeviceClass `json:"class"`
 Bus BusType `json:"bus"`
 Port string `json:"port"`
 VendorID string `json:"vendor_id,omitempty"`
 ProductID string `json:"product_id,omitempty"`
 Protocol string `json:"protocol"`
 DriverStatus DriverStatus `json:"driver_status"`
 Capabilities []string `json:"capabilities"`
 Metadata map[string]string `json:"metadata"`
 LastSeen time.Time `json:"last_seen"`
}
type HostType string
const (
 HostPC HostType = "PC_WORKSTATION"
 HostVehicle HostType = "VEHICLE_ECU"
 HostRobot HostType = "ROBOT_CONTROLLER"
 HostAppliance HostType = "SMART_APPLIANCE"
 HostMobile HostType = "MOBILE_DEVICE"
)
type HardwareProfile struct {
 HostType HostType `json:"host_type"`
 OS string `json:"os"`
 Arch string `json:"arch"`
 Hostname string `json:"hostname"`
 Buses []BusType `json:"buses"`
 Devices []*DiscoveredDevice `json:"devices"`
 TotalDevices int `json:"total_devices"`
 ScanDuration time.Duration `json:"scan_duration"`
 Timestamp time.Time `json:"timestamp"`
}
type ScannerFunc func(ctx context.Context) ([]*DiscoveredDevice, error)
// Manager is a legacy inventory, not the native OS kernel driver loader.
type Manager struct {
 mu sync.RWMutex
 profile *HardwareProfile
 devices map[string]*DiscoveredDevice
 customScanners []ScannerFunc
}
func NewManager() *Manager {
 host, err := os.Hostname()
 if err != nil || host == "" { host = "swypik-node" }
 return &Manager{devices: make(map[string]*DiscoveredDevice), profile: &HardwareProfile{
  HostType: HostPC, OS: runtime.GOOS, Arch: runtime.GOARCH, Hostname: host,
  Buses: []BusType{}, Devices: []*DiscoveredDevice{}, Timestamp: time.Now(),
 }}
}
func (m *Manager) RegisterScanner(scanner ScannerFunc) {
 m.mu.Lock(); defer m.mu.Unlock()
 m.customScanners = append(m.customScanners, scanner)
}
func (m *Manager) Scan(ctx context.Context) (*HardwareProfile, error) {
 if err := ctx.Err(); err != nil { return nil, err }
 start := time.Now()
 found := map[string]*DiscoveredDevice{}
 add := func(d *DiscoveredDevice) { if d != nil && d.ID != "" { found[d.ID] = d } }
 add(&DiscoveredDevice{
  ID: "dev_host_compute_0", Name: fmt.Sprintf("Host (%s/%s, %d logical CPUs)", runtime.GOOS, runtime.GOARCH, runtime.NumCPU()),
  Class: ClassCompute, Port: "SYSTEM", Protocol: "HOST_RUNTIME", DriverStatus: DriverReady,
  Capabilities: []string{}, Metadata: map[string]string{"cores": fmt.Sprint(runtime.NumCPU()), "arch": runtime.GOARCH, "os": runtime.GOOS}, LastSeen: time.Now(),
 })
 for _, d := range m.scanGPUDevices(ctx) { add(d) }
 for _, d := range m.scanUARTPorts() { add(d) }
 for _, d := range m.scanCANInterfaces() { add(d) }
 m.mu.RLock()
 scanners := append([]ScannerFunc(nil), m.customScanners...)
 m.mu.RUnlock()
 for _, scan := range scanners {
  if err := ctx.Err(); err != nil { return nil, err }
  if devices, err := scan(ctx); err == nil { for _, d := range devices { add(d) } }
 }
 m.mu.Lock(); defer m.mu.Unlock()
 for _, d := range m.devices { if _, exists := found[d.ID]; !exists { add(d) } }
 devices := make([]*DiscoveredDevice, 0, len(found))
 buses := map[BusType]bool{}
 hostType := HostPC
 hasVehicle, hasRobot, hasAppliance := false, false, false
 for _, d := range found {
  m.devices[d.ID] = d
  devices = append(devices, d)
  if d.Bus != "" { buses[d.Bus] = true }
  switch d.Class { case ClassVehicle: hasVehicle = true; case ClassRobot: hasRobot = true; case ClassAppliance: hasAppliance = true }
 }
 if hasVehicle { hostType = HostVehicle } else if hasRobot { hostType = HostRobot } else if hasAppliance { hostType = HostAppliance } else if runtime.GOOS == "android" { hostType = HostMobile }
 list := make([]BusType, 0, len(buses)); for b := range buses { list = append(list, b) }
 m.profile = &HardwareProfile{HostType: hostType, OS: runtime.GOOS, Arch: runtime.GOARCH, Hostname: m.profile.Hostname, Buses: list, Devices: devices, TotalDevices: len(devices), ScanDuration: time.Since(start), Timestamp: time.Now()}
 return m.profile, nil
}
func (m *Manager) RegisterDevice(dev *DiscoveredDevice) {
 if dev == nil { return }
 m.mu.Lock(); defer m.mu.Unlock()
 dev.LastSeen = time.Now(); m.devices[dev.ID] = dev
}
func (m *Manager) GetDevice(id string) (*DiscoveredDevice, bool) { m.mu.RLock(); defer m.mu.RUnlock(); dev, ok := m.devices[id]; return dev, ok }
func (m *Manager) GetProfile() *HardwareProfile { m.mu.RLock(); defer m.mu.RUnlock(); return m.profile }
func (m *Manager) ListDevicesByClass(class DeviceClass) []*DiscoveredDevice {
 m.mu.RLock(); defer m.mu.RUnlock(); res := []*DiscoveredDevice{}
 for _, d := range m.devices { if d.Class == class { res = append(res, d) } }; return res
}
