package hive_test

import (
	"context"
	"testing"
	"time"

	"swypik-os/core/hive"
)

func TestHiveMindTaskOffload(t *testing.T) {
	// Small robot edge node
	hm := hive.NewHiveMind("robot_node_1", hive.RoleRobotEdge)

	// Parked vehicle with huge GPU compute
	carNode := &hive.MeshNode{
		ID:             "node_vehicle_cybertruck",
		Name:           "CyberTruck High-Power Gateway",
		Role:           hive.RoleVehicleCompute,
		Endpoint:       "192.168.1.150:9988",
		TFLOPS:         45.0,
		BatteryPercent: 88.0,
		CurrentLoad:    0.10,
		LatencyMs:      4,
	}
	hm.RegisterPeer(carNode)

	// Sensor satellite with weak battery
	sensorNode := &hive.MeshNode{
		ID:             "node_camera_gate",
		Name:           "Perimeter Camera Node",
		Role:           hive.RoleSensorSatellite,
		Endpoint:       "192.168.1.200:9988",
		TFLOPS:         1.2,
		BatteryPercent: 15.0, // Should be skipped due to low battery (<20%)
		CurrentLoad:    0.80,
		LatencyMs:      12,
	}
	hm.RegisterPeer(sensorNode)

	// Best offload node should unequivocally be the vehicle!
	best, err := hm.SelectBestOffloadNode()
	if err != nil {
		t.Fatalf("Failed to select best node: %v", err)
	}
	if best.ID != carNode.ID {
		t.Errorf("Expected car node %s, got %s", carNode.ID, best.ID)
	}

	// Dispatch heavy neural task
	task := &hive.ComputeTask{
		ID:          "task_slam_lidar_01",
		Description: "3D Point Cloud Semantic Segmentation",
		ModelName:   "PointNet-Sovereign-v3",
		Priority:    10,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	completed, err := hm.OffloadTask(ctx, task)
	if err != nil {
		t.Fatalf("OffloadTask failed: %v", err)
	}

	if completed.Status != "COMPLETED" {
		t.Errorf("Expected status COMPLETED, got %s", completed.Status)
	}

	status := hm.GetMeshStatus()
	if status["active_peers"] != 2 {
		t.Errorf("Expected 2 active peers, got %v", status["active_peers"])
	}
}
