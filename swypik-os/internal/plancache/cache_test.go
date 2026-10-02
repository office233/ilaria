package plancache

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testStoragePolicy = "verified-local-test-v1"

var syntheticTestKey = []byte("public-synthetic-plancache-test-key-v1")

type countingVerifier struct {
	calls  atomic.Int64
	reject atomic.Bool
}

func (v *countingVerifier) VerifySnapshot(_ context.Context, claim Claim) error {
	v.calls.Add(1)
	if v.reject.Load() {
		return errors.New("synthetic policy rejection")
	}
	expected := syntheticAttestation(claim.Identity, claim.StoragePolicy, claim.CanonicalIRHash, claim.Provenance)
	if !hmac.Equal(expected, claim.Attestation) {
		return errors.New("invalid synthetic attestation")
	}
	return nil
}

func TestIdentifyInvalidatesEveryInput(t *testing.T) {
	base := IdentityInput{
		Source: []byte("fn main() -> i64 { 7 }"),
		Dependencies: []Input{
			{Name: "dep/b", Content: []byte("B")},
			{Name: "dep/a", Content: []byte("A")},
		},
		Compiler: []byte("swyp-compiler|sha256:compiler-a|version:3"),
		Protocol: []byte("core-ir-protocol-v7"),
		Policy:   []byte("effects=read-only;canonical=v2"),
	}
	want, err := Identify(base)
	if err != nil {
		t.Fatal(err)
	}

	reordered := base
	reordered.Dependencies = []Input{base.Dependencies[1], base.Dependencies[0]}
	got, err := Identify(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if got.Key != want.Key {
		t.Fatalf("dependency order changed identity: %s != %s", got.Key, want.Key)
	}

	tests := map[string]func(*IdentityInput){
		"source": func(in *IdentityInput) {
			in.Source = []byte("fn main() -> i64 { 8 }")
		},
		"dependency": func(in *IdentityInput) {
			in.Dependencies = append([]Input(nil), in.Dependencies...)
			in.Dependencies[0].Content = []byte("B2")
		},
		"compiler": func(in *IdentityInput) {
			in.Compiler = []byte("swyp-compiler|sha256:compiler-b|version:3")
		},
		"protocol": func(in *IdentityInput) {
			in.Protocol = []byte("core-ir-protocol-v8")
		},
		"policy": func(in *IdentityInput) {
			in.Policy = []byte("effects=none;canonical=v2")
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			in := base
			mutate(&in)
			changed, err := Identify(in)
			if err != nil {
				t.Fatal(err)
			}
			if changed.Key == want.Key {
				t.Fatalf("%s change did not invalidate identity", name)
			}
		})
	}

	duplicate := base
	duplicate.Dependencies = []Input{{Name: "same", Content: []byte("a")}, {Name: "same", Content: []byte("b")}}
	if _, err := Identify(duplicate); err == nil {
		t.Fatal("duplicate dependency names were accepted")
	}
}

func TestCacheMissHitAndFreshHostVerification(t *testing.T) {
	cfg := testConfig(t.TempDir(), "hit")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()

	id := testIdentity(t, "source-hit")
	snapshot := testSnapshot(id, []byte("canonical-core-ir"), []byte("synthetic provenance"))
	verifier := &countingVerifier{}

	if _, err := cache.Get(context.Background(), id, verifier); !errors.Is(err, ErrMiss) {
		t.Fatalf("miss error = %v", err)
	}
	if verifier.calls.Load() != 0 {
		t.Fatalf("verifier called on miss: %d", verifier.calls.Load())
	}
	if err := cache.Put(context.Background(), id, snapshot, verifier); err != nil {
		t.Fatal(err)
	}
	if verifier.calls.Load() != 1 {
		t.Fatalf("put verifier calls = %d", verifier.calls.Load())
	}
	got, err := cache.Get(context.Background(), id, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.CanonicalIR) != string(snapshot.CanonicalIR) ||
		string(got.Provenance) != string(snapshot.Provenance) ||
		string(got.Attestation) != string(snapshot.Attestation) {
		t.Fatal("cache hit bytes differ")
	}
	if verifier.calls.Load() != 2 {
		t.Fatalf("get did not reverify; calls = %d", verifier.calls.Load())
	}

	verifier.reject.Store(true)
	if _, err := cache.Get(context.Background(), id, verifier); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("rejected verifier error = %v", err)
	}
	verifier.reject.Store(false)
	if _, err := cache.Get(context.Background(), id, verifier); err != nil {
		t.Fatalf("host rejection incorrectly destroyed immutable entry: %v", err)
	}
}

func TestCacheIdentityInvalidationMisses(t *testing.T) {
	cfg := testConfig(t.TempDir(), "identity-miss")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	verifier := &countingVerifier{}

	baseInput := IdentityInput{
		Source: []byte("base-source"),
		Dependencies: []Input{
			{Name: "dep/a", Content: []byte("A")},
			{Name: "dep/b", Content: []byte("B")},
		},
		Compiler: []byte("compiler-a"),
		Protocol: []byte("protocol-a"),
		Policy:   []byte("policy-a"),
	}
	base, err := Identify(baseInput)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Put(context.Background(), base, testSnapshot(base, []byte("base-ir"), []byte("base-provenance")), verifier); err != nil {
		t.Fatal(err)
	}

	tests := map[string]func(*IdentityInput){
		"source": func(in *IdentityInput) {
			in.Source = []byte("changed-source")
		},
		"dependency": func(in *IdentityInput) {
			in.Dependencies = append([]Input(nil), in.Dependencies...)
			in.Dependencies[1].Content = []byte("changed-B")
		},
		"compiler": func(in *IdentityInput) {
			in.Compiler = []byte("compiler-b")
		},
		"protocol": func(in *IdentityInput) {
			in.Protocol = []byte("protocol-b")
		},
		"policy": func(in *IdentityInput) {
			in.Policy = []byte("policy-b")
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			in := baseInput
			mutate(&in)
			changed, err := Identify(in)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := cache.Get(context.Background(), changed, verifier); !errors.Is(err, ErrMiss) {
				t.Fatalf("changed %s error = %v, want miss", name, err)
			}
		})
	}
}

func TestCacheImmutableConflict(t *testing.T) {
	cfg := testConfig(t.TempDir(), "immutable")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	id := testIdentity(t, "immutable-source")
	first := testSnapshot(id, []byte("canonical-ir-a"), []byte("provenance-a"))
	second := testSnapshot(id, []byte("canonical-ir-b"), []byte("provenance-b"))
	verifier := &countingVerifier{}
	if err := cache.Put(context.Background(), id, first, verifier); err != nil {
		t.Fatal(err)
	}
	if err := cache.Put(context.Background(), id, second, verifier); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting immutable put error = %v", err)
	}
	got, err := cache.Get(context.Background(), id, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.CanonicalIR) != string(first.CanonicalIR) {
		t.Fatalf("conflicting put replaced immutable entry: %q", got.CanonicalIR)
	}
}

func TestCacheTruncationIsCorruptAndPurged(t *testing.T) {
	cfg := testConfig(t.TempDir(), "truncate")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()

	id := testIdentity(t, "truncate-source")
	snapshot := testSnapshot(id, []byte("0123456789abcdef"), []byte("provenance"))
	verifier := &countingVerifier{}
	if err := cache.Put(context.Background(), id, snapshot, verifier); err != nil {
		t.Fatal(err)
	}
	irPath := filepath.Join(cfg.Root, cfg.Partition, id.Key, entryIRName)
	if err := os.WriteFile(irPath, []byte("0123"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Get(context.Background(), id, verifier); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("truncated entry error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.Root, cfg.Partition, id.Key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("corrupt entry was not purged, stat error = %v", err)
	}
	if _, err := cache.Get(context.Background(), id, verifier); !errors.Is(err, ErrMiss) {
		t.Fatalf("post-purge error = %v", err)
	}
}

func TestCacheDoesNotTrustRewrittenMetadataAndAttestation(t *testing.T) {
	cfg := testConfig(t.TempDir(), "tamper")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()

	id := testIdentity(t, "tamper-source")
	snapshot := testSnapshot(id, []byte("verified-ir"), []byte("provenance"))
	verifier := &countingVerifier{}
	if err := cache.Put(context.Background(), id, snapshot, verifier); err != nil {
		t.Fatal(err)
	}

	entryDir := filepath.Join(cfg.Root, cfg.Partition, id.Key)
	attestation := []byte("attacker-controlled-attestation")
	if err := os.WriteFile(filepath.Join(entryDir, entryAttestation), attestation, 0600); err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(entryDir, entryMetadataName)
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	var meta diskMetadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	meta.AttestationHash = digestHex(attestation)
	meta.AttestationBytes = int64(len(attestation))
	raw, err = json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath, raw, 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := cache.Get(context.Background(), id, verifier); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("rewritten evidence error = %v", err)
	}
}

func TestCacheConcurrentProducersSingleImmutableEntry(t *testing.T) {
	root := t.TempDir()
	cfg := testConfig(root, "concurrent")
	const producers = 12
	caches := make([]*Cache, producers)
	for i := range caches {
		cache, err := Open(cfg)
		if err != nil {
			t.Fatal(err)
		}
		caches[i] = cache
		defer cache.Close()
	}

	id := testIdentity(t, "same-source")
	snapshot := testSnapshot(id, []byte("same-canonical-ir"), []byte("same-provenance"))
	var wg sync.WaitGroup
	errs := make(chan error, producers)
	for _, cache := range caches {
		wg.Add(1)
		go func(cache *Cache) {
			defer wg.Done()
			errs <- cache.Put(context.Background(), id, snapshot, &countingVerifier{})
		}(cache)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent put: %v", err)
		}
	}
	stats, err := caches[0].Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Entries != 1 {
		t.Fatalf("entries = %d, want 1", stats.Entries)
	}
}

func TestProcessProducerHelper(t *testing.T) {
	if os.Getenv("PLANCACHE_PROCESS_HELPER") != "1" {
		return
	}
	root := os.Getenv("PLANCACHE_PROCESS_ROOT")
	if root == "" {
		t.Fatal("missing helper root")
	}
	cfg := testConfig(root, "process-concurrent")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	id := testIdentity(t, "process-source")
	snapshot := testSnapshot(id, []byte("process-canonical-ir"), []byte("process-provenance"))
	if err := cache.Put(context.Background(), id, snapshot, &countingVerifier{}); err != nil {
		t.Fatal(err)
	}
}

func TestCacheConcurrentProcesses(t *testing.T) {
	root := t.TempDir()
	cfg := testConfig(root, "process-concurrent")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const producers = 4
	var wg sync.WaitGroup
	errs := make(chan error, producers)
	for i := 0; i < producers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cmd := exec.Command(exe, "-test.run=^TestProcessProducerHelper$", "-test.v=false")
			cmd.Env = append(os.Environ(),
				"PLANCACHE_PROCESS_HELPER=1",
				"PLANCACHE_PROCESS_ROOT="+root,
			)
			output, err := cmd.CombinedOutput()
			if err != nil {
				errs <- fmt.Errorf("%w: %s", err, output)
				return
			}
			errs <- nil
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	cache, err = Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	stats, err := cache.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Entries != 1 {
		t.Fatalf("entries after process race = %d, want 1", stats.Entries)
	}
}

func TestOpenCleansAbandonedPublication(t *testing.T) {
	root := t.TempDir()
	cfg := testConfig(root, "crash")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}

	tempPath := filepath.Join(root, cfg.Partition, ".tmp-crash-fixture")
	if err := os.Mkdir(tempPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tempPath, entryIRName), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	cache, err = Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	if _, err := os.Stat(tempPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("abandoned publication remains: %v", err)
	}
}

func TestQuotaEvictionIsOldestPublishedFirst(t *testing.T) {
	cfg := testConfig(t.TempDir(), "eviction-count")
	cfg.MaxEntries = 2
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	verifier := &countingVerifier{}

	ids := []Identity{
		testIdentity(t, "source-a"),
		testIdentity(t, "source-b"),
		testIdentity(t, "source-c"),
	}
	for i, id := range ids {
		if i > 0 {
			time.Sleep(time.Millisecond)
		}
		if err := cache.Put(context.Background(), id, testSnapshot(id, []byte("ir"), []byte("prov")), verifier); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := cache.Get(context.Background(), ids[0], verifier); !errors.Is(err, ErrMiss) {
		t.Fatalf("oldest entry error = %v", err)
	}
	for _, id := range ids[1:] {
		if _, err := cache.Get(context.Background(), id, verifier); err != nil {
			t.Fatalf("retained entry %s: %v", id.Key, err)
		}
	}
	stats, err := cache.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Entries != 2 {
		t.Fatalf("entries = %d, want 2", stats.Entries)
	}
}

func TestByteQuotaEvictsBeforePublication(t *testing.T) {
	probeCfg := testConfig(t.TempDir(), "byte-probe")
	probe, err := Open(probeCfg)
	if err != nil {
		t.Fatal(err)
	}
	idA := testIdentity(t, "byte-a")
	snapshotA := testSnapshot(idA, make([]byte, 2048), []byte("prov"))
	if err := probe.Put(context.Background(), idA, snapshotA, &countingVerifier{}); err != nil {
		t.Fatal(err)
	}
	stats, err := probe.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig(t.TempDir(), "byte-quota")
	cfg.MaxBytes = stats.Bytes*2 - 1
	cfg.MaxIRBytes = 2048
	cfg.MaxProvenanceBytes = 64
	cfg.MaxAttestationBytes = 256
	cfg.MaxMetadataBytes = cfg.MaxBytes
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	verifier := &countingVerifier{}
	idB := testIdentity(t, "byte-b")
	snapshotB := testSnapshot(idB, make([]byte, 2048), []byte("prov"))
	if err := cache.Put(context.Background(), idA, snapshotA, verifier); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	if err := cache.Put(context.Background(), idB, snapshotB, verifier); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Get(context.Background(), idA, verifier); !errors.Is(err, ErrMiss) {
		t.Fatalf("first byte-quota entry error = %v", err)
	}
	if _, err := cache.Get(context.Background(), idB, verifier); err != nil {
		t.Fatalf("new byte-quota entry missing: %v", err)
	}
	finalStats, err := cache.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if finalStats.Bytes > cfg.MaxBytes {
		t.Fatalf("bytes = %d exceeds quota %d", finalStats.Bytes, cfg.MaxBytes)
	}
}

func TestSizeLimitFailsBeforeVerifier(t *testing.T) {
	cfg := testConfig(t.TempDir(), "limit")
	cfg.MaxIRBytes = 8
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	id := testIdentity(t, "limit-source")
	verifier := &countingVerifier{}
	snapshot := testSnapshot(id, []byte("123456789"), []byte("prov"))
	if err := cache.Put(context.Background(), id, snapshot, verifier); !errors.Is(err, ErrLimit) {
		t.Fatalf("oversize error = %v", err)
	}
	if verifier.calls.Load() != 0 {
		t.Fatalf("verifier ran before size refusal: %d", verifier.calls.Load())
	}
}

func TestPartitionPolicyMismatchFailsClosed(t *testing.T) {
	root := t.TempDir()
	cfg := testConfig(root, "policy")
	cache, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}
	changed := cfg
	changed.MaxEntries++
	if _, err := Open(changed); !errors.Is(err, ErrPolicyMismatch) {
		t.Fatalf("changed partition policy error = %v", err)
	}
}

func TestSymlinkRootAndPartitionRejected(t *testing.T) {
	t.Run("root", func(t *testing.T) {
		parent := t.TempDir()
		realRoot := filepath.Join(parent, "real")
		if err := os.Mkdir(realRoot, 0700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(parent, "link")
		if err := os.Symlink(realRoot, link); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		cfg := testConfig(link, "cache")
		if _, err := Open(cfg); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("symlink root error = %v", err)
		}
	})

	t.Run("partition", func(t *testing.T) {
		root := t.TempDir()
		outside := t.TempDir()
		partition := "linked-partition"
		if err := os.Symlink(outside, filepath.Join(root, partition)); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		cfg := testConfig(root, partition)
		if _, err := Open(cfg); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("symlink partition error = %v", err)
		}
	})
}

func testConfig(root, partition string) Config {
	return Config{
		Root:                root,
		Partition:           partition,
		StoragePolicy:       testStoragePolicy,
		MaxEntries:          128,
		MaxBytes:            32 << 20,
		MaxIRBytes:          8 << 20,
		MaxProvenanceBytes:  1 << 20,
		MaxAttestationBytes: 1 << 20,
		MaxMetadataBytes:    1 << 20,
	}
}

func testIdentity(t testing.TB, source string) Identity {
	t.Helper()
	id, err := Identify(IdentityInput{
		Source: []byte(source),
		Dependencies: []Input{
			{Name: "std/core", Content: []byte("core-v1")},
			{Name: "app/types", Content: []byte("types-v4")},
		},
		Compiler: []byte("swyp-test-compiler|sha256:0123456789abcdef|version:3"),
		Protocol: []byte("core-ir-protocol-v7"),
		Policy:   []byte("effects=read-only;canonical=v2"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func testSnapshot(id Identity, ir, provenance []byte) Snapshot {
	irHash := digestHex(ir)
	return Snapshot{
		CanonicalIR: append([]byte(nil), ir...),
		Provenance:  append([]byte(nil), provenance...),
		Attestation: syntheticAttestation(id, testStoragePolicy, irHash, provenance),
	}
}

func syntheticAttestation(id Identity, storagePolicy, irHash string, provenance []byte) []byte {
	mac := hmac.New(sha256.New, syntheticTestKey)
	_, _ = mac.Write([]byte("plancache-synthetic-attestation-v1\x00"))
	_, _ = mac.Write([]byte(id.Key))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(storagePolicy))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(irHash))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(provenance)
	return []byte(hex.EncodeToString(mac.Sum(nil)))
}
