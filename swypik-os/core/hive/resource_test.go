package hive

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestPhoneHiveBoundsPeerAndTaskWorkingSet(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	h := NewHiveMind("local", RoleRobotEdge)
	if h.maxPeers != 16 || h.maxTasks != 16 {
		t.Fatalf("peer/task caps=%d/%d", h.maxPeers, h.maxTasks)
	}
	for i := 0; i < 80; i++ {
		h.RegisterPeer(&MeshNode{
			ID:             fmt.Sprintf("peer-%03d", i),
			Name:           "edge",
			Role:           RoleWorkstationPrimary,
			TFLOPS:         1,
			BatteryPercent: 100,
			CurrentLoad:    0,
			LatencyMs:      1,
		})
	}
	if got := len(h.peers); got != 16 {
		t.Fatalf("resident peers=%d want 16", got)
	}

	for i := 0; i < 80; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _ = h.OffloadTask(ctx, &ComputeTask{ID: fmt.Sprintf("task-%03d", i)})
		cancel()
	}
	if len(h.tasks) != 16 || len(h.taskOrder) != 16 {
		t.Fatalf("resident tasks/order=%d/%d want 16/16", len(h.tasks), len(h.taskOrder))
	}
}

func TestHiveDoesNotRetainTaskPayloadInResidentHistory(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	h := NewHiveMind("local", RoleRobotEdge)
	h.RegisterPeer(&MeshNode{
		ID:             "peer",
		Name:           "edge",
		Role:           RoleWorkstationPrimary,
		TFLOPS:         1,
		BatteryPercent: 100,
		LatencyMs:      1,
	})
	payload := make([]byte, 2<<20)
	task := &ComputeTask{ID: "large", Payload: payload}
	_, _ = h.OffloadTask(context.Background(), task)
	stored := h.tasks["large"]
	if stored == nil {
		t.Fatal("task not retained")
	}
	if len(stored.Payload) != 0 {
		t.Fatalf("resident task retained %d payload bytes", len(stored.Payload))
	}
	if len(task.Payload) != len(payload) {
		t.Fatal("caller task payload was mutated")
	}
}
