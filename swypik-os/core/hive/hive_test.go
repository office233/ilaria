package hive_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"swypik-os/core/evidence"
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

	// Without a transport the task is routed on paper and reported as not run.
	routed, err := hm.OffloadTask(ctx, task)
	if !errors.Is(err, hive.ErrNoTransport) {
		t.Fatalf("OffloadTask err = %v, want ErrNoTransport", err)
	}
	if routed.AssignedNodeID != carNode.ID || routed.Status != "NOT_EXECUTED" || routed.Evidence != evidence.Simulated {
		t.Errorf("routed task = node %s status %s evidence %s", routed.AssignedNodeID, routed.Status, routed.Evidence)
	}
	if strings.Contains(routed.Result, "completed") || strings.Contains(routed.Result, "zero latency") {
		t.Errorf("task result claims execution: %s", routed.Result)
	}

	status := hm.GetMeshStatus()
	if status["registered_peers"] != 2 {
		t.Errorf("Expected 2 registered peers, got %v", status["registered_peers"])
	}
	if status["mesh_health"] != "UNVERIFIED" || status["transport"] != "none" || status["executed_tasks"] != 0 {
		t.Errorf("mesh status claims more than a local registry: %v", status)
	}
}
