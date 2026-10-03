package plancache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	identityVersion     = 1
	maxDependencies     = 4096
	maxDependencyName   = 4096
	sha256HexLength     = sha256.Size * 2
	identityDomainLabel = "swypik.plancache.identity.v1"
)

// Input is one dependency identity input. Name is a logical dependency name,
// not a filesystem path; both Name and exact Content bytes participate in the
// cache identity.
type Input struct {
	Name    string
	Content []byte
}

// IdentityInput contains every compiler input which may change the verified
// Core IR snapshot. Compiler, Protocol, and Policy are opaque canonical bytes
// selected by the trusted host.
type IdentityInput struct {
	Source       []byte
	Dependencies []Input
	Compiler     []byte
	Protocol     []byte
	Policy       []byte
}

type NamedHash struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

// Identity is safe to persist: it contains only content digests and logical
// dependency names, never source/dependency contents.
type Identity struct {
	Version          int         `json:"version"`
	Key              string      `json:"key"`
	SourceHash       string      `json:"source_sha256"`
	DependencyHashes []NamedHash `json:"dependencies"`
	CompilerHash     string      `json:"compiler_sha256"`
	ProtocolHash     string      `json:"protocol_sha256"`
	PolicyHash       string      `json:"policy_sha256"`
}

// Identify derives a stable cache identity from exact source/dependency
// contents plus compiler, protocol, and policy identities. Dependency ordering
// supplied by the caller does not affect the identity; dependency names must be
// unique.
func Identify(in IdentityInput) (Identity, error) {
	if len(in.Compiler) == 0 {
		return Identity{}, fmt.Errorf("plancache: compiler identity is required")
	}
	if len(in.Protocol) == 0 {
		return Identity{}, fmt.Errorf("plancache: protocol identity is required")
	}
	if len(in.Policy) == 0 {
		return Identity{}, fmt.Errorf("plancache: policy identity is required")
	}
	if len(in.Dependencies) > maxDependencies {
		return Identity{}, fmt.Errorf("plancache: dependency count %d exceeds %d", len(in.Dependencies), maxDependencies)
	}

	deps := make([]NamedHash, len(in.Dependencies))
	for i, dep := range in.Dependencies {
		if err := validateDependencyName(dep.Name); err != nil {
			return Identity{}, err
		}
		deps[i] = NamedHash{Name: dep.Name, SHA256: digestHex(dep.Content)}
	}
	sort.Slice(deps, func(i, j int) bool { return deps[i].Name < deps[j].Name })
	for i := 1; i < len(deps); i++ {
		if deps[i-1].Name == deps[i].Name {
			return Identity{}, fmt.Errorf("plancache: duplicate dependency name %q", deps[i].Name)
		}
	}

	id := Identity{
		Version:          identityVersion,
		SourceHash:       digestHex(in.Source),
		DependencyHashes: deps,
		CompilerHash:     digestHex(in.Compiler),
		ProtocolHash:     digestHex(in.Protocol),
		PolicyHash:       digestHex(in.Policy),
	}
	key, err := deriveIdentityKey(id)
	if err != nil {
		return Identity{}, err
	}
	id.Key = key
	return id, nil
}

func (id Identity) validate() error {
	if id.Version != identityVersion {
		return fmt.Errorf("plancache: unsupported identity version %d", id.Version)
	}
	if !isDigest(id.Key) {
		return fmt.Errorf("plancache: invalid identity key")
	}
	if !isDigest(id.SourceHash) || !isDigest(id.CompilerHash) || !isDigest(id.ProtocolHash) || !isDigest(id.PolicyHash) {
		return fmt.Errorf("plancache: invalid identity component digest")
	}
	if len(id.DependencyHashes) > maxDependencies {
		return fmt.Errorf("plancache: dependency count %d exceeds %d", len(id.DependencyHashes), maxDependencies)
	}
	for i, dep := range id.DependencyHashes {
		if err := validateDependencyName(dep.Name); err != nil {
			return err
		}
		if !isDigest(dep.SHA256) {
			return fmt.Errorf("plancache: invalid digest for dependency %q", dep.Name)
		}
		if i > 0 && id.DependencyHashes[i-1].Name >= dep.Name {
			return fmt.Errorf("plancache: dependencies are not uniquely sorted")
		}
	}
	key, err := deriveIdentityKey(id)
	if err != nil {
		return err
	}
	if key != id.Key {
		return fmt.Errorf("plancache: identity key does not match components")
	}
	return nil
}

func sameIdentity(a, b Identity) bool {
	if a.Version != b.Version || a.Key != b.Key || a.SourceHash != b.SourceHash ||
		a.CompilerHash != b.CompilerHash || a.ProtocolHash != b.ProtocolHash ||
		a.PolicyHash != b.PolicyHash || len(a.DependencyHashes) != len(b.DependencyHashes) {
		return false
	}
	for i := range a.DependencyHashes {
		if a.DependencyHashes[i] != b.DependencyHashes[i] {
			return false
		}
	}
	return true
}

func deriveIdentityKey(id Identity) (string, error) {
	h := sha256.New()
	writePart(h, []byte(identityDomainLabel))
	writeUint64(h, uint64(id.Version))
	for _, digest := range []string{id.SourceHash, id.CompilerHash, id.ProtocolHash, id.PolicyHash} {
		raw, err := hex.DecodeString(digest)
		if err != nil || len(raw) != sha256.Size {
			return "", fmt.Errorf("plancache: invalid identity digest")
		}
		writePart(h, raw)
	}
	writeUint64(h, uint64(len(id.DependencyHashes)))
	for _, dep := range id.DependencyHashes {
		writePart(h, []byte(dep.Name))
		raw, err := hex.DecodeString(dep.SHA256)
		if err != nil || len(raw) != sha256.Size {
			return "", fmt.Errorf("plancache: invalid dependency digest")
		}
		writePart(h, raw)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writePart(h hash.Hash, value []byte) {
	writeUint64(h, uint64(len(value)))
	_, _ = h.Write(value)
}

func writeUint64(h hash.Hash, value uint64) {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], value)
	_, _ = h.Write(buf[:])
}

func validateDependencyName(name string) error {
	if name == "" || len(name) > maxDependencyName || !utf8.ValidString(name) || strings.IndexByte(name, 0) >= 0 {
		return fmt.Errorf("plancache: invalid dependency name")
	}
	return nil
}

func digestHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func isDigest(value string) bool {
	if len(value) != sha256HexLength || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
