package supervisor

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

func bindingKey(function, effect string) string { return function + "\x00" + effect }
func scopeKey(function, effect, capability, path string) string {
	return function + "\x00" + effect + "\x00" + capability + "\x00" + path
}

func validHash(hash string) bool {
	decoded, err := hex.DecodeString(hash)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == hash
}

func normalizeConfig(config Config) (Config, string, error) {
	if config.Kernel == nil || config.Verifier == nil || config.ExecutorCredential == "" || config.VerifierCredential == "" ||
		!filepath.IsAbs(config.LedgerPath) || config.ExecutorID == config.VerifierID {
		return Config{}, "", fmt.Errorf("supervisor requires explicit kernel, ledger, independent identities and verifier")
	}
	if err := effects.ValidateSigningIdentity(config.SignerKeyID, config.PrivateKey); err != nil {
		return Config{}, "", err
	}
	if config.ExecutionPolicyHash != "" && !validHash(config.ExecutionPolicyHash) {
		return Config{}, "", fmt.Errorf("invalid host execution policy hash")
	}
	if err := normalizeContinuationPolicy(&config.Continuation); err != nil {
		return Config{}, "", err
	}
	config.PrivateKey = append(ed25519.PrivateKey(nil), config.PrivateKey...)
	config.Plan.Bindings = append([]Binding{}, config.Plan.Bindings...)
	config.Plan.Effects = append([]string{}, config.Plan.Effects...)
	config.Scopes = append([]Scope{}, config.Scopes...)
	roots := make(map[string]string, len(config.RootPaths))
	for alias, hostPath := range config.RootPaths {
		if alias == "" || !filepath.IsAbs(hostPath) {
			return Config{}, "", fmt.Errorf("supervisor read roots require aliases and absolute paths")
		}
		roots[alias] = filepath.Clean(hostPath)
	}
	config.RootPaths = roots
	if config.Now == nil {
		config.Now = time.Now
	}
	config.Plan.Deadline = config.Plan.Deadline.UTC()
	if config.Plan.RunID == "" || config.Plan.MaxEffects < 1 || config.Plan.MaxEffects > MaxPlanEffects || config.Plan.MaxReadBytes < 0 || config.Plan.Deadline.IsZero() ||
		config.Plan.Deadline.UnixMilli() <= 0 || config.Plan.Deadline.Year() > 9999 {
		return Config{}, "", fmt.Errorf("invalid supervisor plan budget/deadline")
	}
	if config.Continuation.Enabled && (config.Plan.FuelLimit < 1 || config.Plan.FuelLimit > MaxContinuationFuel || config.Plan.MaxEffectBytes > MaxContinuationEffectBytes) {
		return Config{}, "", fmt.Errorf("authenticated continuation requires explicit original guest budgets")
	}
	if err := effects.ValidateBinding(effects.Binding{TaskID: config.Plan.TaskID, NodeID: "configured", AttemptID: "configured",
		ExecutorID: config.ExecutorID, GrantID: "configured", LeaseID: "configured", Fence: 1}); err != nil {
		return Config{}, "", err
	}
	if err := effects.ValidateBinding(effects.Binding{TaskID: "configured", NodeID: "configured", AttemptID: "configured",
		ExecutorID: config.VerifierID, GrantID: "configured", LeaseID: "configured", Fence: 1}); err != nil {
		return Config{}, "", err
	}
	if err := effects.ValidateRequest(wire.EffectRequest{ProtocolVersion: 1, RequestID: config.Plan.RunID + ":64", ModuleHash: config.Plan.ModuleHash,
		Function: config.Plan.Entry, Effect: "clock.read", Capability: "configured", Path: ""}); err != nil {
		return Config{}, "", fmt.Errorf("invalid supervisor program identity: %w", err)
	}
	declared := make(map[string]bool)
	for _, effect := range config.Plan.Effects {
		if declared[effect] || (effect != "clock.read" && effect != "fs.read") {
			return Config{}, "", fmt.Errorf("unsupported or duplicate declared plan effect")
		}
		declared[effect] = true
	}
	bindings := make(map[string]string)
	for _, binding := range config.Plan.Bindings {
		key := bindingKey(binding.Function, binding.Effect)
		if _, duplicate := bindings[key]; duplicate || !declared[binding.Effect] {
			return Config{}, "", fmt.Errorf("ambiguous or undeclared plan capability binding")
		}
		path := ""
		if binding.Effect == "fs.read" {
			path = "configured"
		}
		if err := effects.ValidateRequest(wire.EffectRequest{ProtocolVersion: 1, RequestID: "configured", ModuleHash: config.Plan.ModuleHash,
			Function: binding.Function, Effect: binding.Effect, Capability: binding.Capability, Path: path}); err != nil {
			return Config{}, "", err
		}
		bindings[key] = binding.Capability
	}
	seenScopes := make(map[string]bool)
	for _, scope := range config.Scopes {
		key := scopeKey(scope.Function, scope.Effect, scope.Capability, scope.Path)
		if seenScopes[key] || bindings[bindingKey(scope.Function, scope.Effect)] != scope.Capability {
			return Config{}, "", fmt.Errorf("host scope does not match a unique compiled binding")
		}
		if err := effects.ValidateRequest(wire.EffectRequest{ProtocolVersion: 1, RequestID: "configured", ModuleHash: config.Plan.ModuleHash,
			Function: scope.Function, Effect: scope.Effect, Capability: scope.Capability, Path: scope.Path}); err != nil {
			return Config{}, "", err
		}
		if scope.Effect == "fs.read" {
			if roots[scope.RootID] == "" || scope.MaxReadBytes <= 0 || scope.MaxReadBytes > effects.MaxValueBytes {
				return Config{}, "", fmt.Errorf("invalid host file read scope")
			}
		} else if scope.RootID != "" || scope.MaxReadBytes != 0 {
			return Config{}, "", fmt.Errorf("clock scope must not carry filesystem authority")
		}
		seenScopes[key] = true
	}
	sort.Strings(config.Plan.Effects)
	sort.Slice(config.Plan.Bindings, func(i, j int) bool {
		return bindingKey(config.Plan.Bindings[i].Function, config.Plan.Bindings[i].Effect) < bindingKey(config.Plan.Bindings[j].Function, config.Plan.Bindings[j].Effect)
	})
	sort.Slice(config.Scopes, func(i, j int) bool {
		left, right := config.Scopes[i], config.Scopes[j]
		return scopeKey(left.Function, left.Effect, left.Capability, left.Path) < scopeKey(right.Function, right.Effect, right.Capability, right.Path)
	})
	continuationKeyHash := ""
	if config.Continuation.Enabled {
		digest := sha256.Sum256(config.Continuation.Key[:])
		continuationKeyHash = hex.EncodeToString(digest[:])
	}
	policy := struct {
		Plan                Plan              `json:"plan"`
		Scopes              []Scope           `json:"scopes"`
		RootPaths           map[string]string `json:"root_paths"`
		ExecutorID          string            `json:"executor_id"`
		VerifierID          string            `json:"verifier_id"`
		SignerKeyID         string            `json:"signer_key_id"`
		ExecutionPolicyHash string            `json:"execution_policy_hash"`
		ContinuationMode    string            `json:"continuation_mode,omitempty"`
		ContinuationDir     string            `json:"continuation_directory,omitempty"`
		ContinuationKeyID   string            `json:"continuation_key_id,omitempty"`
		ContinuationKeyHash string            `json:"continuation_key_hash,omitempty"`
		ContinuationMax     int               `json:"continuation_max_bytes,omitempty"`
	}{config.Plan, config.Scopes, config.RootPaths, config.ExecutorID, config.VerifierID, config.SignerKeyID, config.ExecutionPolicyHash,
		config.Continuation.Mode, config.Continuation.Directory, config.Continuation.KeyID, continuationKeyHash, config.Continuation.MaxEnvelopeBytes}
	raw, err := json.Marshal(policy)
	if err != nil {
		return Config{}, "", err
	}
	hash := sha256.Sum256(raw)
	return config, hex.EncodeToString(hash[:]), nil
}

func normalizeContinuationPolicy(policy *ContinuationPolicy) error {
	if !policy.Enabled {
		if policy.Mode != "" || policy.Directory != "" || policy.KeyID != "" || policy.MaxEnvelopeBytes != 0 || !bytes.Equal(policy.Key[:], make([]byte, len(policy.Key))) {
			return fmt.Errorf("disabled continuation policy must not carry key or persistence authority")
		}
		return nil
	}
	if policy.Mode != ContinuationModeAES256GCM || !filepath.IsAbs(policy.Directory) || policy.KeyID == "" || len(policy.KeyID) > 128 ||
		strings.ContainsAny(policy.KeyID, "/\\\\\x00") || policy.MaxEnvelopeBytes < 1 || policy.MaxEnvelopeBytes > MaxContinuationEnvelopeBytes ||
		bytes.Equal(policy.Key[:], make([]byte, len(policy.Key))) {
		return fmt.Errorf("invalid explicit authenticated continuation policy")
	}
	policy.Directory = filepath.Clean(policy.Directory)
	return nil
}

func nodeID(planHash string, sequence uint64) string {
	return "sup:" + planHash[:32] + ":node:" + strconv.FormatUint(sequence, 10)
}

func grantID(planHash string, sequence uint64) string {
	return "sup:" + planHash[:32] + ":grant:" + strconv.FormatUint(sequence, 10)
}
