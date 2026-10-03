package service

import (
	"context"
	"testing"
	"time"

	"swypik-os/core/network"
)

func TestNetworkSnapshotUsesFreshCacheWithoutProbe(t *testing.T) {
	s := &Service{
		networkStatus: network.Status{HostOS: "cached"},
		networkAt:     time.Now(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := s.networkSnapshot(ctx)
	if err != nil {
		t.Fatalf("fresh cache should not probe cancelled context: %v", err)
	}
	if got.HostOS != "cached" {
		t.Fatalf("got=%+v", got)
	}
}
