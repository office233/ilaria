package plancache

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"swypik-os/internal/safepath"
)

const (
	cacheFormatVersion = 1
	lockFileName       = ".plancache.lock"
	partitionFileName  = ".partition.json"
	entryMetadataName  = "meta.json"
	entryIRName        = "ir.bin"
	entryProvenance    = "provenance.bin"
	entryAttestation   = "attestation.bin"
	maxMetadataHard    = int64(16 << 20)
	lockRetryInterval  = 10 * time.Millisecond
)

var expectedEntryFiles = map[string]struct{}{
	entryMetadataName: {},
	entryIRName:       {},
	entryProvenance:   {},
	entryAttestation:  {},
}

// Config explicitly defines one isolated cache partition and all bounded disk
// allocations. A partition persists this policy on first Open; subsequent
// producers must use the exact same policy or Open fails.
type Config struct {
	Root                string
	Partition           string
	StoragePolicy       string
	MaxEntries          int
	MaxBytes            int64
	MaxIRBytes          int64
	MaxProvenanceBytes  int64
	MaxAttestationBytes int64
	MaxMetadataBytes    int64
}

type Stats struct {
	Entries int
	Bytes   int64
}

type Cache struct {
	cfg   Config
	state sync.RWMutex
	root  *os.Root
}

type partitionMetadata struct {
	Version             int    `json:"version"`
	Partition           string `json:"partition"`
	StoragePolicy       string `json:"storage_policy"`
	MaxEntries          int    `json:"max_entries"`
	MaxBytes            int64  `json:"max_bytes"`
	MaxIRBytes          int64  `json:"max_ir_bytes"`
	MaxProvenanceBytes  int64  `json:"max_provenance_bytes"`
	MaxAttestationBytes int64  `json:"max_attestation_bytes"`
	MaxMetadataBytes    int64  `json:"max_metadata_bytes"`
}

type diskMetadata struct {
	Version          int      `json:"version"`
	Key              string   `json:"key"`
	StoragePolicy    string   `json:"storage_policy"`
	Identity         Identity `json:"identity"`
	CanonicalIRHash  string   `json:"canonical_ir_sha256"`
	ProvenanceHash   string   `json:"provenance_sha256"`
	AttestationHash  string   `json:"attestation_sha256"`
	IRBytes          int64    `json:"ir_bytes"`
	ProvenanceBytes  int64    `json:"provenance_bytes"`
	AttestationBytes int64    `json:"attestation_bytes"`
	PublishedUnixNS  int64    `json:"published_unix_ns"`
}

type diskEntry struct {
	key       string
	bytes     int64
	published int64
	meta      diskMetadata
}

// Open creates or opens one explicit cache partition. Root must be an absolute,
// non-symlink-resolving path. os.Root is used for every operation beneath it so
// path traversal and symlink escapes cannot leave the configured root.
func Open(config Config) (*Cache, error) {
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	absRoot, err := filepath.Abs(filepath.Clean(config.Root))
	if err != nil || !filepath.IsAbs(config.Root) {
		return nil, fmt.Errorf("%w: root must be absolute", ErrUnsafePath)
	}
	if err := os.MkdirAll(absRoot, 0700); err != nil {
		return nil, fmt.Errorf("plancache: create root: %w", err)
	}
	info, err := os.Lstat(absRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: root must be a real directory", ErrUnsafePath)
	}
	parent := filepath.Dir(absRoot)
	canonicalParent, err := safepath.Canonical(parent)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve root parent: %v", ErrUnsafePath, err)
	}
	canonicalRoot := filepath.Join(canonicalParent, filepath.Base(absRoot))
	if parent == absRoot {
		canonicalRoot = canonicalParent
	}
	cInfo, err := os.Lstat(canonicalRoot)
	if err != nil || !cInfo.IsDir() || cInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: root must be a real directory", ErrUnsafePath)
	}
	resolved, err := filepath.EvalSymlinks(canonicalRoot)
	if err != nil {
		return nil, fmt.Errorf("%w: resolve root: %v", ErrUnsafePath, err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || !samePath(canonicalRoot, resolved) {
		return nil, fmt.Errorf("%w: root contains a symlink or reparse indirection", ErrUnsafePath)
	}

	base, err := os.OpenRoot(canonicalRoot)
	if err != nil {
		return nil, fmt.Errorf("plancache: open root: %w", err)
	}
	defer base.Close()

	if err := base.Mkdir(config.Partition, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, fmt.Errorf("plancache: create partition: %w", err)
	}
	partitionInfo, err := base.Lstat(config.Partition)
	if err != nil || !partitionInfo.IsDir() || partitionInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: partition must be a real directory", ErrUnsafePath)
	}
	partitionRoot, err := base.OpenRoot(config.Partition)
	if err != nil {
		return nil, fmt.Errorf("%w: open partition: %v", ErrUnsafePath, err)
	}

	cache := &Cache{cfg: config, root: partitionRoot}
	if err := cache.ensureLockFile(); err != nil {
		_ = partitionRoot.Close()
		return nil, err
	}
	if err := cache.withLock(context.Background(), func(root *os.Root) error {
		if err := cache.ensurePartitionMetadataLocked(root); err != nil {
			return err
		}
		if err := cache.cleanupTempsLocked(root); err != nil {
			return err
		}
		return cache.reconcileQuotaLocked(root)
	}); err != nil {
		_ = partitionRoot.Close()
		return nil, err
	}
	return cache, nil
}

func (c *Cache) Close() error {
	c.state.Lock()
	defer c.state.Unlock()
	if c.root == nil {
		return nil
	}
	err := c.root.Close()
	c.root = nil
	return err
}

// Get returns an immutable snapshot only after recomputing all payload hashes
// and obtaining a fresh host-verifier decision. A corrupt target entry is
// removed under the cache lock and reported as ErrCorrupt.
func (c *Cache) Get(ctx context.Context, identity Identity, verifier Verifier) (Snapshot, error) {
	if ctx == nil {
		return Snapshot{}, fmt.Errorf("plancache: nil context")
	}
	if err := identity.validate(); err != nil {
		return Snapshot{}, err
	}
	if verifier == nil {
		return Snapshot{}, fmt.Errorf("%w: verifier is required", ErrUntrusted)
	}

	var snapshot Snapshot
	var claim Claim
	err := c.withLock(ctx, func(root *os.Root) error {
		if err := c.cleanupTempsLocked(root); err != nil {
			return err
		}
		loaded, loadedClaim, err := c.loadSnapshotLocked(root, identity)
		if err != nil {
			if errors.Is(err, ErrCorrupt) {
				_ = root.RemoveAll(identity.Key)
				_ = syncRoot(root)
			}
			return err
		}
		snapshot = loaded
		claim = loadedClaim
		return nil
	})
	if err != nil {
		return Snapshot{}, err
	}
	if err := verifyWithHost(ctx, verifier, claim); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// Put validates the caller-provided snapshot before touching disk. Publication
// is serialized across processes, quota-checked, file-synced, and exposed by one
// atomic directory rename. Existing immutable entries must be byte-identical.
func (c *Cache) Put(ctx context.Context, identity Identity, snapshot Snapshot, verifier Verifier) error {
	if ctx == nil {
		return fmt.Errorf("plancache: nil context")
	}
	if err := identity.validate(); err != nil {
		return err
	}
	if err := c.validateSnapshotSizes(snapshot); err != nil {
		return err
	}
	rawBytes, err := sumSizes(
		int64(len(snapshot.CanonicalIR)),
		int64(len(snapshot.Provenance)),
		int64(len(snapshot.Attestation)),
	)
	if err != nil || rawBytes > c.cfg.MaxBytes {
		return fmt.Errorf("%w: snapshot payload cannot fit configured partition", ErrQuota)
	}
	claim := c.claim(identity, snapshot)
	if err := verifyWithHost(ctx, verifier, claim); err != nil {
		return err
	}

	return c.withLock(ctx, func(root *os.Root) error {
		if err := c.cleanupTempsLocked(root); err != nil {
			return err
		}
		existing, _, err := c.loadSnapshotLocked(root, identity)
		switch {
		case err == nil:
			if bytes.Equal(existing.CanonicalIR, snapshot.CanonicalIR) &&
				bytes.Equal(existing.Provenance, snapshot.Provenance) &&
				bytes.Equal(existing.Attestation, snapshot.Attestation) {
				return nil
			}
			return fmt.Errorf("%w: key %s already contains different verified bytes", ErrConflict, identity.Key)
		case errors.Is(err, ErrMiss):
			// Publish below.
		case errors.Is(err, ErrCorrupt):
			if removeErr := root.RemoveAll(identity.Key); removeErr != nil {
				return fmt.Errorf("plancache: remove corrupt entry: %w", removeErr)
			}
			if err := syncRoot(root); err != nil {
				return err
			}
		default:
			return err
		}

		meta := diskMetadata{
			Version:          cacheFormatVersion,
			Key:              identity.Key,
			StoragePolicy:    c.cfg.StoragePolicy,
			Identity:         identity,
			CanonicalIRHash:  digestHex(snapshot.CanonicalIR),
			ProvenanceHash:   digestHex(snapshot.Provenance),
			AttestationHash:  digestHex(snapshot.Attestation),
			IRBytes:          int64(len(snapshot.CanonicalIR)),
			ProvenanceBytes:  int64(len(snapshot.Provenance)),
			AttestationBytes: int64(len(snapshot.Attestation)),
			PublishedUnixNS:  time.Now().UnixNano(),
		}
		metaBytes, err := json.Marshal(meta)
		if err != nil {
			return fmt.Errorf("plancache: encode metadata: %w", err)
		}
		if int64(len(metaBytes)) > c.cfg.MaxMetadataBytes {
			return fmt.Errorf("%w: metadata is %d bytes, max is %d", ErrLimit, len(metaBytes), c.cfg.MaxMetadataBytes)
		}
		required, err := sumSizes(int64(len(metaBytes)), meta.IRBytes, meta.ProvenanceBytes, meta.AttestationBytes)
		if err != nil || required > c.cfg.MaxBytes {
			return fmt.Errorf("%w: entry requires more than %d bytes", ErrQuota, c.cfg.MaxBytes)
		}
		if err := c.ensureCapacityLocked(root, required); err != nil {
			return err
		}
		return c.publishLocked(root, identity.Key, metaBytes, snapshot)
	})
}

func (c *Cache) Remove(ctx context.Context, identity Identity) error {
	if ctx == nil {
		return fmt.Errorf("plancache: nil context")
	}
	if err := identity.validate(); err != nil {
		return err
	}
	return c.withLock(ctx, func(root *os.Root) error {
		if err := c.cleanupTempsLocked(root); err != nil {
			return err
		}
		if _, err := root.Lstat(identity.Key); errors.Is(err, fs.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		if err := root.RemoveAll(identity.Key); err != nil {
			return fmt.Errorf("plancache: remove entry: %w", err)
		}
		return syncRoot(root)
	})
}

func (c *Cache) Stats(ctx context.Context) (Stats, error) {
	if ctx == nil {
		return Stats{}, fmt.Errorf("plancache: nil context")
	}
	var result Stats
	err := c.withLock(ctx, func(root *os.Root) error {
		if err := c.cleanupTempsLocked(root); err != nil {
			return err
		}
		stats, _, err := c.scanEntriesLocked(root, false)
		if err != nil {
			return err
		}
		result = stats
		return nil
	})
	return result, err
}

func validateConfig(config Config) error {
	if config.Root == "" || !filepath.IsAbs(config.Root) {
		return fmt.Errorf("%w: absolute root is required", ErrUnsafePath)
	}
	if !safeToken(config.Partition, 64) {
		return fmt.Errorf("%w: invalid partition", ErrUnsafePath)
	}
	if !safeToken(config.StoragePolicy, 128) {
		return fmt.Errorf("plancache: invalid storage policy")
	}
	if config.MaxEntries <= 0 || config.MaxBytes <= 0 || config.MaxIRBytes <= 0 ||
		config.MaxProvenanceBytes <= 0 || config.MaxAttestationBytes <= 0 ||
		config.MaxMetadataBytes <= 0 {
		return fmt.Errorf("plancache: all quotas must be positive")
	}
	if config.MaxMetadataBytes > maxMetadataHard {
		return fmt.Errorf("plancache: metadata limit exceeds hard maximum %d", maxMetadataHard)
	}
	for name, limit := range map[string]int64{
		"IR":          config.MaxIRBytes,
		"provenance":  config.MaxProvenanceBytes,
		"attestation": config.MaxAttestationBytes,
		"metadata":    config.MaxMetadataBytes,
	} {
		if limit > config.MaxBytes {
			return fmt.Errorf("plancache: %s limit exceeds partition byte quota", name)
		}
	}
	return nil
}

func safeToken(value string, max int) bool {
	if value == "" || len(value) > max || value == "." || value == ".." {
		return false
	}
	for i := 0; i < len(value); i++ {
		b := value[i]
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') ||
			(b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' {
			continue
		}
		return false
	}
	return true
}

func samePath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (c *Cache) ensureLockFile() error {
	c.state.RLock()
	root := c.root
	c.state.RUnlock()
	if root == nil {
		return ErrClosed
	}
	info, err := root.Lstat(lockFileName)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: lock path is not a regular file", ErrUnsafePath)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("plancache: inspect lock file: %w", err)
	}
	file, err := root.OpenFile(lockFileName, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			info, statErr := root.Lstat(lockFileName)
			if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: raced lock path is unsafe", ErrUnsafePath)
			}
			return nil
		}
		return fmt.Errorf("plancache: create lock file: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("plancache: sync lock file: %w", err)
	}
	if err := file.Close(); err != nil {
		return err
	}
	return syncRoot(root)
}

func (c *Cache) withLock(ctx context.Context, fn func(*os.Root) error) error {
	c.state.RLock()
	defer c.state.RUnlock()
	if c.root == nil {
		return ErrClosed
	}
	info, err := c.root.Lstat(lockFileName)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: lock file is unavailable or unsafe", ErrUnsafePath)
	}
	file, err := c.root.OpenFile(lockFileName, os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("plancache: open lock file: %w", err)
	}
	defer file.Close()

	for {
		locked, lockErr := tryLockFile(file)
		if lockErr != nil {
			return fmt.Errorf("plancache: acquire lock: %w", lockErr)
		}
		if locked {
			break
		}
		timer := time.NewTimer(lockRetryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
	defer unlockFile(file)
	if err := ctx.Err(); err != nil {
		return err
	}
	return fn(c.root)
}

func (c *Cache) ensurePartitionMetadataLocked(root *os.Root) error {
	expected := partitionMetadata{
		Version:             cacheFormatVersion,
		Partition:           c.cfg.Partition,
		StoragePolicy:       c.cfg.StoragePolicy,
		MaxEntries:          c.cfg.MaxEntries,
		MaxBytes:            c.cfg.MaxBytes,
		MaxIRBytes:          c.cfg.MaxIRBytes,
		MaxProvenanceBytes:  c.cfg.MaxProvenanceBytes,
		MaxAttestationBytes: c.cfg.MaxAttestationBytes,
		MaxMetadataBytes:    c.cfg.MaxMetadataBytes,
	}
	raw, err := readBoundedRegular(root, partitionFileName, c.cfg.MaxMetadataBytes)
	if err == nil {
		var actual partitionMetadata
		if err := decodeStrictJSON(raw, &actual); err != nil {
			return fmt.Errorf("%w: partition metadata: %v", ErrCorrupt, err)
		}
		if actual != expected {
			return fmt.Errorf("%w: partition %q was created with a different cache policy", ErrPolicyMismatch, c.cfg.Partition)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	data, err := json.Marshal(expected)
	if err != nil {
		return err
	}
	if int64(len(data)) > c.cfg.MaxMetadataBytes {
		return fmt.Errorf("%w: partition metadata exceeds metadata limit", ErrLimit)
	}
	temp, err := randomName(".cfg-")
	if err != nil {
		return err
	}
	if err := writeSyncedFile(root, temp, data); err != nil {
		_ = root.Remove(temp)
		return err
	}
	defer root.Remove(temp)
	if err := root.Rename(temp, partitionFileName); err != nil {
		if _, statErr := root.Lstat(partitionFileName); statErr == nil {
			raw, readErr := readBoundedRegular(root, partitionFileName, c.cfg.MaxMetadataBytes)
			if readErr != nil {
				return readErr
			}
			var actual partitionMetadata
			if decodeErr := decodeStrictJSON(raw, &actual); decodeErr == nil && actual == expected {
				return nil
			}
		}
		return fmt.Errorf("plancache: publish partition metadata: %w", err)
	}
	return syncRoot(root)
}

func (c *Cache) cleanupTempsLocked(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		entries, readErr := dir.ReadDir(64)
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".tmp-") || strings.HasPrefix(name, ".cfg-") {
				if err := root.RemoveAll(name); err != nil {
					return fmt.Errorf("plancache: remove abandoned publication %q: %w", name, err)
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return syncRoot(root)
}

func (c *Cache) reconcileQuotaLocked(root *os.Root) error {
	for {
		stats, oldest, err := c.scanEntriesLocked(root, true)
		if err != nil {
			return err
		}
		if stats.Entries <= c.cfg.MaxEntries && stats.Bytes <= c.cfg.MaxBytes {
			return nil
		}
		if oldest == nil {
			return fmt.Errorf("%w: no evictable entry", ErrQuota)
		}
		if err := root.RemoveAll(oldest.key); err != nil {
			return fmt.Errorf("plancache: evict %s: %w", oldest.key, err)
		}
		if err := syncRoot(root); err != nil {
			return err
		}
	}
}

func (c *Cache) ensureCapacityLocked(root *os.Root, required int64) error {
	for {
		stats, oldest, err := c.scanEntriesLocked(root, true)
		if err != nil {
			return err
		}
		nextBytes, overflow := addInt64(stats.Bytes, required)
		if !overflow && stats.Entries+1 <= c.cfg.MaxEntries && nextBytes <= c.cfg.MaxBytes {
			return nil
		}
		if oldest == nil {
			return fmt.Errorf("%w: entry cannot fit configured partition", ErrQuota)
		}
		if err := root.RemoveAll(oldest.key); err != nil {
			return fmt.Errorf("plancache: evict %s: %w", oldest.key, err)
		}
		if err := syncRoot(root); err != nil {
			return err
		}
	}
}

func (c *Cache) scanEntriesLocked(root *os.Root, purgeCorrupt bool) (Stats, *diskEntry, error) {
	var stats Stats
	var oldest *diskEntry
	dir, err := root.Open(".")
	if err != nil {
		return stats, nil, err
	}
	defer dir.Close()

	for {
		entries, readErr := dir.ReadDir(64)
		for _, entry := range entries {
			name := entry.Name()
			switch {
			case name == lockFileName || name == partitionFileName:
				continue
			case strings.HasPrefix(name, ".tmp-") || strings.HasPrefix(name, ".cfg-"):
				if purgeCorrupt {
					if err := root.RemoveAll(name); err != nil {
						return stats, nil, err
					}
					continue
				}
				return stats, nil, fmt.Errorf("%w: abandoned publication %q", ErrCorrupt, name)
			case !isDigest(name):
				return stats, nil, fmt.Errorf("%w: unexpected path %q in isolated partition", ErrCorrupt, name)
			}

			disk, inspectErr := c.inspectEntryLocked(root, name)
			if inspectErr != nil {
				if purgeCorrupt && errors.Is(inspectErr, ErrCorrupt) {
					if err := root.RemoveAll(name); err != nil {
						return stats, nil, err
					}
					if err := syncRoot(root); err != nil {
						return stats, nil, err
					}
					continue
				}
				return stats, nil, inspectErr
			}
			stats.Entries++
			total, overflow := addInt64(stats.Bytes, disk.bytes)
			if overflow {
				return stats, nil, fmt.Errorf("%w: byte accounting overflow", ErrCorrupt)
			}
			stats.Bytes = total
			if oldest == nil || disk.published < oldest.published ||
				(disk.published == oldest.published && disk.key < oldest.key) {
				copy := disk
				oldest = &copy
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return stats, nil, readErr
		}
	}
	return stats, oldest, nil
}

func (c *Cache) inspectEntryLocked(root *os.Root, key string) (diskEntry, error) {
	info, err := root.Lstat(key)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return diskEntry{}, ErrMiss
		}
		return diskEntry{}, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return diskEntry{}, fmt.Errorf("%w: entry %s is not a real directory", ErrCorrupt, key)
	}

	metaRaw, err := readBoundedRegular(root, filepath.Join(key, entryMetadataName), c.cfg.MaxMetadataBytes)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, ErrLimit) || errors.Is(err, ErrUnsafePath) {
			return diskEntry{}, fmt.Errorf("%w: entry %s metadata: %v", ErrCorrupt, key, err)
		}
		return diskEntry{}, err
	}
	var meta diskMetadata
	if err := decodeStrictJSON(metaRaw, &meta); err != nil {
		return diskEntry{}, fmt.Errorf("%w: entry %s metadata: %v", ErrCorrupt, key, err)
	}
	if meta.Version != cacheFormatVersion || meta.Key != key {
		return diskEntry{}, fmt.Errorf("%w: entry %s metadata identity", ErrCorrupt, key)
	}
	if meta.StoragePolicy != c.cfg.StoragePolicy {
		return diskEntry{}, fmt.Errorf("%w: entry %s storage policy", ErrPolicyMismatch, key)
	}
	if err := meta.Identity.validate(); err != nil || meta.Identity.Key != key {
		return diskEntry{}, fmt.Errorf("%w: entry %s identity", ErrCorrupt, key)
	}
	if !isDigest(meta.CanonicalIRHash) || !isDigest(meta.ProvenanceHash) || !isDigest(meta.AttestationHash) ||
		meta.PublishedUnixNS <= 0 {
		return diskEntry{}, fmt.Errorf("%w: entry %s digest/timestamp metadata", ErrCorrupt, key)
	}
	if meta.IRBytes < 0 || meta.IRBytes > c.cfg.MaxIRBytes ||
		meta.ProvenanceBytes < 0 || meta.ProvenanceBytes > c.cfg.MaxProvenanceBytes ||
		meta.AttestationBytes < 0 || meta.AttestationBytes > c.cfg.MaxAttestationBytes {
		return diskEntry{}, fmt.Errorf("%w: entry %s declared size", ErrCorrupt, key)
	}

	entryDir, err := root.Open(key)
	if err != nil {
		return diskEntry{}, err
	}
	seen := make(map[string]struct{}, len(expectedEntryFiles))
	for {
		entries, readErr := entryDir.ReadDir(8)
		for _, child := range entries {
			name := child.Name()
			if _, ok := expectedEntryFiles[name]; !ok {
				_ = entryDir.Close()
				return diskEntry{}, fmt.Errorf("%w: entry %s has unexpected file %q", ErrCorrupt, key, name)
			}
			if _, duplicate := seen[name]; duplicate {
				_ = entryDir.Close()
				return diskEntry{}, fmt.Errorf("%w: entry %s duplicate file %q", ErrCorrupt, key, name)
			}
			seen[name] = struct{}{}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = entryDir.Close()
			return diskEntry{}, readErr
		}
	}
	if err := entryDir.Close(); err != nil {
		return diskEntry{}, err
	}
	if len(seen) != len(expectedEntryFiles) {
		return diskEntry{}, fmt.Errorf("%w: entry %s is incomplete", ErrCorrupt, key)
	}

	irSize, err := regularFileSize(root, filepath.Join(key, entryIRName), c.cfg.MaxIRBytes)
	if err != nil {
		return diskEntry{}, fmt.Errorf("%w: entry %s IR: %v", ErrCorrupt, key, err)
	}
	provenanceSize, err := regularFileSize(root, filepath.Join(key, entryProvenance), c.cfg.MaxProvenanceBytes)
	if err != nil {
		return diskEntry{}, fmt.Errorf("%w: entry %s provenance: %v", ErrCorrupt, key, err)
	}
	attestationSize, err := regularFileSize(root, filepath.Join(key, entryAttestation), c.cfg.MaxAttestationBytes)
	if err != nil {
		return diskEntry{}, fmt.Errorf("%w: entry %s attestation: %v", ErrCorrupt, key, err)
	}
	if irSize != meta.IRBytes || provenanceSize != meta.ProvenanceBytes || attestationSize != meta.AttestationBytes {
		return diskEntry{}, fmt.Errorf("%w: entry %s size metadata mismatch", ErrCorrupt, key)
	}
	total, err := sumSizes(int64(len(metaRaw)), irSize, provenanceSize, attestationSize)
	if err != nil {
		return diskEntry{}, fmt.Errorf("%w: entry %s byte accounting overflow", ErrCorrupt, key)
	}
	return diskEntry{key: key, bytes: total, published: meta.PublishedUnixNS, meta: meta}, nil
}

func (c *Cache) loadSnapshotLocked(root *os.Root, identity Identity) (Snapshot, Claim, error) {
	disk, err := c.inspectEntryLocked(root, identity.Key)
	if err != nil {
		return Snapshot{}, Claim{}, err
	}
	if !sameIdentity(disk.meta.Identity, identity) {
		return Snapshot{}, Claim{}, fmt.Errorf("%w: requested identity does not match entry", ErrCorrupt)
	}
	ir, err := readBoundedRegular(root, filepath.Join(identity.Key, entryIRName), c.cfg.MaxIRBytes)
	if err != nil {
		return Snapshot{}, Claim{}, fmt.Errorf("%w: IR payload: %v", ErrCorrupt, err)
	}
	provenance, err := readBoundedRegular(root, filepath.Join(identity.Key, entryProvenance), c.cfg.MaxProvenanceBytes)
	if err != nil {
		return Snapshot{}, Claim{}, fmt.Errorf("%w: provenance payload: %v", ErrCorrupt, err)
	}
	attestation, err := readBoundedRegular(root, filepath.Join(identity.Key, entryAttestation), c.cfg.MaxAttestationBytes)
	if err != nil {
		return Snapshot{}, Claim{}, fmt.Errorf("%w: attestation payload: %v", ErrCorrupt, err)
	}
	if digestHex(ir) != disk.meta.CanonicalIRHash ||
		digestHex(provenance) != disk.meta.ProvenanceHash ||
		digestHex(attestation) != disk.meta.AttestationHash {
		return Snapshot{}, Claim{}, fmt.Errorf("%w: payload digest mismatch", ErrCorrupt)
	}
	snapshot := Snapshot{CanonicalIR: ir, Provenance: provenance, Attestation: attestation}
	return snapshot, c.claim(identity, snapshot), nil
}

func (c *Cache) claim(identity Identity, snapshot Snapshot) Claim {
	return Claim{
		Identity:        identity,
		StoragePolicy:   c.cfg.StoragePolicy,
		CanonicalIRHash: digestHex(snapshot.CanonicalIR),
		IRBytes:         int64(len(snapshot.CanonicalIR)),
		Provenance:      snapshot.Provenance,
		Attestation:     snapshot.Attestation,
	}
}

func (c *Cache) validateSnapshotSizes(snapshot Snapshot) error {
	for name, sizeAndLimit := range map[string][2]int64{
		"IR":          {int64(len(snapshot.CanonicalIR)), c.cfg.MaxIRBytes},
		"provenance":  {int64(len(snapshot.Provenance)), c.cfg.MaxProvenanceBytes},
		"attestation": {int64(len(snapshot.Attestation)), c.cfg.MaxAttestationBytes},
	} {
		if sizeAndLimit[0] > sizeAndLimit[1] {
			return fmt.Errorf("%w: %s is %d bytes, max is %d", ErrLimit, name, sizeAndLimit[0], sizeAndLimit[1])
		}
	}
	return nil
}

func (c *Cache) publishLocked(root *os.Root, key string, meta []byte, snapshot Snapshot) error {
	temp, err := randomName(".tmp-")
	if err != nil {
		return err
	}
	if err := root.Mkdir(temp, 0700); err != nil {
		return fmt.Errorf("plancache: create publication directory: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = root.RemoveAll(temp)
		}
	}()
	for _, item := range []struct {
		name string
		data []byte
	}{
		{entryIRName, snapshot.CanonicalIR},
		{entryProvenance, snapshot.Provenance},
		{entryAttestation, snapshot.Attestation},
		{entryMetadataName, meta},
	} {
		if err := writeSyncedFile(root, filepath.Join(temp, item.name), item.data); err != nil {
			return err
		}
	}
	tempDir, err := root.Open(temp)
	if err != nil {
		return err
	}
	if err := syncDirectory(tempDir); err != nil {
		_ = tempDir.Close()
		return fmt.Errorf("plancache: sync publication directory: %w", err)
	}
	if err := tempDir.Close(); err != nil {
		return err
	}
	if err := root.Rename(temp, key); err != nil {
		return fmt.Errorf("plancache: atomic publication: %w", err)
	}
	published = true
	return syncRoot(root)
}

func writeSyncedFile(root *os.Root, name string, data []byte) error {
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("plancache: create %s: %w", name, err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = file.Close()
		}
	}()
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("plancache: write %s: %w", name, err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("plancache: sync %s: %w", name, err)
	}
	if err := file.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

func readBoundedRegular(root *os.Root, name string, limit int64) ([]byte, error) {
	size, err := regularFileSize(root, name, limit)
	if err != nil {
		return nil, err
	}
	if size > int64(int(^uint(0)>>1)) {
		return nil, fmt.Errorf("%w: %s cannot fit address space", ErrLimit, name)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data := make([]byte, int(size))
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, fmt.Errorf("%w: truncated %s", ErrCorrupt, name)
	}
	var extra [1]byte
	n, readErr := file.Read(extra[:])
	if n != 0 || (readErr != nil && !errors.Is(readErr, io.EOF)) {
		return nil, fmt.Errorf("%w: grew while reading %s", ErrCorrupt, name)
	}
	return data, nil
}

func regularFileSize(root *os.Root, name string, limit int64) (int64, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("%w: %s is not a regular file", ErrUnsafePath, name)
	}
	size := info.Size()
	if size < 0 || size > limit {
		return 0, fmt.Errorf("%w: %s is %d bytes, max is %d", ErrLimit, name, size, limit)
	}
	return size, nil
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return err
	}
	return nil
}

func syncRoot(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := syncDirectory(dir); err != nil {
		return fmt.Errorf("plancache: sync cache directory: %w", err)
	}
	return nil
}

func randomName(prefix string) (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("plancache: random publication name: %w", err)
	}
	return prefix + hex.EncodeToString(raw[:]), nil
}

func sumSizes(values ...int64) (int64, error) {
	var total int64
	for _, value := range values {
		next, overflow := addInt64(total, value)
		if overflow {
			return 0, fmt.Errorf("integer overflow")
		}
		total = next
	}
	return total, nil
}

func addInt64(a, b int64) (int64, bool) {
	if b > 0 && a > int64(^uint64(0)>>1)-b {
		return 0, true
	}
	if b < 0 && a < -int64(^uint64(0)>>1)-1-b {
		return 0, true
	}
	return a + b, false
}
