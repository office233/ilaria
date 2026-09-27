package hal_test

import (
	"context"
	"testing"
	"time"

	"swypik-os/core/hal"
)

func TestHALDiscovery(t *testing.T) {
	mgr := hal.NewManager()
	if mgr == nil {
		t.Fatal("NewManager returned nil")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	profile, err := mgr.Scan(ctx)
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	if profile == nil {
		t.Fatal("Profile is nil")
	}

	if profile.TotalDevices < 1 {
		t.Errorf("Expected at least host compute device, got %d", profile.TotalDevices)
	}

	computeDev, ok := mgr.GetDevice("dev_host_compute_0")
	if !ok || computeDev == nil {
		t.Fatal("Expected host compute device not found")
	}

	if computeDev.Class != hal.ClassCompute {
		t.Errorf("Expected ClassCompute, got %s", computeDev.Class)
	}
}

func TestHALVehicleAndRobotAttachment(t *testing.T) {
	mgr := hal.NewManager()

	// Attach Vehicle
	veh := mgr.AttachVehicleSimulation("Tesla Model S / CyberTruck Gateway", "5YJSA1E21LF123456")
	if veh == nil {
		t.Fatal("AttachVehicleSimulation returned nil")
	}

	// Attach Robot
	robot := mgr.AttachRobotSimulation("Swypik Autonomous Manipulator", 6)
	if robot == nil {
		t.Fatal("AttachRobotSimulation returned nil")
	}

	// Attach Appliance
	appliance := mgr.AttachApplianceSimulation("Industrial Power Hub", 8)
	if appliance == nil {
		t.Fatal("AttachApplianceSimulation returned nil")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	profile, err := mgr.Scan(ctx)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}

	// Since vehicle is attached, host type should reflect vehicle or cyber node
	if profile.HostType != hal.HostVehicle {
		t.Errorf("Expected HostVehicle when car gateway present, got %s", profile.HostType)
	}

	vehicles := mgr.ListDevicesByClass(hal.ClassVehicle)
	if len(vehicles) != 1 {
		t.Errorf("Expected 1 vehicle, got %d", len(vehicles))
	}

	robots := mgr.ListDevicesByClass(hal.ClassRobot)
	if len(robots) != 1 {
		t.Errorf("Expected 1 robot, got %d", len(robots))
	}

	appliances := mgr.ListDevicesByClass(hal.ClassAppliance)
	if len(appliances) != 1 {
		t.Errorf("Expected 1 appliance, got %d", len(appliances))
	}
}

func TestHALCUDAGPUDiscovery(t *testing.T) {
	mgr := hal.NewManager()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	profile, err := mgr.Scan(ctx)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}

	hasGPU, model, vram, tflops, cudaVer := mgr.GetGPUComputeCapability()
	t.Logf("GPU Discovery Result -> HasGPU: %v | Model: %s | VRAM: %d MB | TFLOPS: %.1f | CUDA: %s",
		hasGPU, model, vram, tflops, cudaVer)

	if hasGPU {
		if vram <= 0 {
			t.Errorf("Expected positive VRAM, got %d", vram)
		}
		if tflops <= 0 {
			t.Errorf("Expected positive TFLOPS, got %.1f", tflops)
		}
		gpuDev, ok := mgr.GetDevice("dev_gpu_nvidia_0")
		if !ok || gpuDev == nil {
			t.Fatal("Expected dev_gpu_nvidia_0 in devices map")
		}
		if gpuDev.Bus != hal.BusPCIe {
			t.Errorf("Expected BusPCIe, got %s", gpuDev.Bus)
		}
		if gpuDev.DriverStatus != hal.DriverReady {
			t.Errorf("Expected DriverReady, got %s", gpuDev.DriverStatus)
		}
	} else {
		t.Log("No discrete NVIDIA GPU detected on test host; fallback active.")
	}

	if profile.TotalDevices < 1 {
		t.Errorf("Expected at least 1 device in profile, got %d", profile.TotalDevices)
	}
}
