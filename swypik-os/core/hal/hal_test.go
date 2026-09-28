package hal_test

import (
 "context"
 "testing"
 "time"
 "swypik-os/core/hal"
)
func TestHALDiscovery(t *testing.T) {
 m := hal.NewManager()
 ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second); defer cancel()
 p, err := m.Scan(ctx); if err != nil { t.Fatal(err) }
 if p == nil || p.TotalDevices < 1 { t.Fatal("missing host inventory") }
 d, ok := m.GetDevice("dev_host_compute_0")
 if !ok || d.Class != hal.ClassCompute { t.Fatal("missing host compute device") }
}
func TestHALVehicleAndRobotAttachment(t *testing.T) {
 m := hal.NewManager()
 m.AttachVehicleSimulation("Test fixture", "TEST-VIN")
 m.AttachRobotSimulation("Test fixture", 6)
 m.AttachApplianceSimulation("Test fixture", 8)
 ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second); defer cancel()
 p, err := m.Scan(ctx); if err != nil { t.Fatal(err) }
 if p.HostType != hal.HostVehicle { t.Fatal(p.HostType) }
 for _, class := range []hal.DeviceClass{hal.ClassVehicle, hal.ClassRobot, hal.ClassAppliance} {
  list := m.ListDevicesByClass(class)
  if len(list) != 1 { t.Fatalf("%s: expected one fixture, got %d", class, len(list)) }
  if list[0].Metadata["simulation"] != "true" { t.Fatal("unlabeled simulation") }
  if list[0].DriverStatus != hal.DriverSimulated { t.Fatalf("%s: simulation fixture reported driver status %s", class, list[0].DriverStatus) }
 }
}
func TestHALCUDAGPUDiscovery(t *testing.T) {
 m := hal.NewManager()
 ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second); defer cancel()
 p, err := m.Scan(ctx); if err != nil { t.Fatal(err) }
 found, model, memory, flops, version := m.GetGPUComputeCapability()
 t.Logf("GPU=%v model=%s VRAM=%d FP32=%f CUDA=%s", found, model, memory, flops, version)
 if flops != 0 { t.Fatal("unmeasured compute must not be reported as measured throughput") }
 if found {
  if memory <= 0 { t.Fatal("missing measured memory") }
  d, ok := m.GetDevice("dev_gpu_nvidia_0")
  if !ok || d.Bus != hal.BusPCIe || d.DriverStatus != hal.DriverReady { t.Fatal("invalid GPU inventory") }
 }
 if p.TotalDevices < 1 { t.Fatal("missing host") }
}
