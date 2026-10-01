package effects

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// MaxPlanBindings bounds a v1 plan to the Core module's 64 functions and the
// two supported broker effects. It is a wire limit, not an authority grant.
const MaxPlanBindings = 128

// ValidatePlan checks the authority-free plan against the same identity rules
// as broker requests. Effects use canonical lexical order; binding keys are
// FUNCTION/EFFECT. Conservative declared effects need not have an instruction
// binding. Actual bindings must reference a declared, supported effect.
func ValidatePlan(plan EffectPlan) error {
	if plan.ProtocolVersion != Version || !identifier(plan.Entry, 64, false) || !moduleHash(plan.ModuleHash) {
		return fmt.Errorf("invalid plan protocol version, module hash or entry identity")
	}
	if plan.Effects == nil || plan.CapabilityBindings == nil || len(plan.Effects) > 2 || len(plan.CapabilityBindings) > MaxPlanBindings {
		return fmt.Errorf("plan requires bounded non-null effects and capability bindings")
	}
	declared := make(map[string]bool, len(plan.Effects))
	for i, effect := range plan.Effects {
		if effect != "clock.read" && effect != "fs.read" {
			return fmt.Errorf("unsupported plan effect %q", effect)
		}
		if i > 0 && plan.Effects[i-1] >= effect {
			return fmt.Errorf("plan effects must be unique and in canonical order")
		}
		declared[effect] = true
	}
	keys := make([]string, 0, len(plan.CapabilityBindings))
	for key := range plan.CapabilityBindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts := strings.SplitN(key, "/", 2)
		if len(parts) != 2 || !identifier(parts[0], 64, false) || !declared[parts[1]] || !capability(plan.CapabilityBindings[key]) {
			return fmt.Errorf("invalid plan capability binding %q", key)
		}
	}
	return nil
}

// DecodePlan rejects ambiguous envelopes and nested binding maps before
// semantic validation. encoding/json alone silently accepts duplicate map keys.
func DecodePlan(data []byte) (EffectPlan, error) {
	var plan EffectPlan
	if err := decodeExact(data, &plan, []string{"protocol_version", "module_hash", "entry", "effects", "capability_bindings"}, ""); err != nil {
		return plan, err
	}
	var envelope struct {
		Bindings json.RawMessage `json:"capability_bindings"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return plan, err
	}
	decoder := json.NewDecoder(bytes.NewReader(envelope.Bindings))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return plan, fmt.Errorf("plan capability bindings must be an object")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return plan, err
		}
		key, ok := token.(string)
		if !ok || seen[key] || len(seen) >= MaxPlanBindings {
			return plan, fmt.Errorf("duplicate or excessive plan capability binding")
		}
		seen[key] = true
		var requirement string
		if err := decoder.Decode(&requirement); err != nil {
			return plan, err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return plan, err
	}
	if err := ValidatePlan(plan); err != nil {
		return plan, err
	}
	return plan, nil
}
