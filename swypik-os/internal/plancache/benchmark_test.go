package plancache

import (
	"context"
	"fmt"
	"testing"
)

func BenchmarkCacheGetHit64KiB(b *testing.B) {
	cfg := testConfig(b.TempDir(), "bench-hit")
	cfg.MaxEntries = 4
	cfg.MaxBytes = 64 << 20
	cache, err := Open(cfg)
	if err != nil {
		b.Fatal(err)
	}
	defer cache.Close()
	id := testIdentity(b, "benchmark-hit-source")
	snapshot := testSnapshot(id, make([]byte, 64<<10), []byte("benchmark provenance"))
	verifier := &countingVerifier{}
	if err := cache.Put(context.Background(), id, snapshot, verifier); err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := cache.Get(context.Background(), id, verifier); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCachePublish64KiB(b *testing.B) {
	root := b.TempDir()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		cfg := testConfig(root, fmt.Sprintf("bench-put-%d", i))
		cfg.MaxEntries = 1
		cfg.MaxBytes = 4 << 20
		cfg.MaxIRBytes = 1 << 20
		cfg.MaxProvenanceBytes = 1 << 20
		cfg.MaxAttestationBytes = 1 << 20
		cfg.MaxMetadataBytes = 1 << 20
		cache, err := Open(cfg)
		if err != nil {
			b.Fatal(err)
		}
		id := testIdentity(b, fmt.Sprintf("benchmark-publish-source-%d", i))
		snapshot := testSnapshot(id, make([]byte, 64<<10), []byte("benchmark provenance"))
		verifier := &countingVerifier{}
		b.StartTimer()
		if err := cache.Put(context.Background(), id, snapshot, verifier); err != nil {
			b.Fatal(err)
		}
		b.StopTimer()
		if err := cache.Close(); err != nil {
			b.Fatal(err)
		}
	}
}
