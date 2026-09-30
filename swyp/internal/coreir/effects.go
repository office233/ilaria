package coreir

import (
	"fmt"
	"sort"
)

// CapabilityRequirement is a symbolic requirement, never an authority token.
// SwypikOS resolves these names to opaque capability references outside the guest
// Core IR. There is intentionally no token/ref/value field here.
type CapabilityRequirement struct {
	Name   string `json:"name"`
	Effect string `json:"effect"`
}

// FunctionSemantics is the immutable effect/capability profile attached to a
// prepared function. Pure functions use Purity="pure" and omit effect metadata.
type FunctionSemantics struct {
	Purity               string                  `json:"purity"`
	EffectVersion        int                     `json:"effect_version,omitempty"`
	Effects              []string                `json:"effects,omitempty"`
	RequiredCapabilities []CapabilityRequirement `json:"required_capabilities,omitempty"`
}

var effectRegistryV1 = map[string]struct{}{
	"clock.read":   {},
	"fs.read":      {},
	"fs.write":     {},
	"io.stderr":    {},
	"io.stdout":    {},
	"model.infer":  {},
	"net.connect":  {},
	"net.fetch":    {},
	"process.exec": {},
	"rng.sample":   {},
	"tool.call":    {},
}

const (
	EffectClockRead   = "clock.read"
	EffectFSRead      = "fs.read"
	EffectFSWrite     = "fs.write"
	EffectIOStdout    = "io.stdout"
	EffectIOStderr    = "io.stderr"
	EffectRNGSample   = "rng.sample"
	EffectNetConnect  = "net.connect"
	EffectNetFetch    = "net.fetch"
	EffectProcessExec = "process.exec"
)

func knownEffect(effect string) bool {
	_, ok := effectRegistryV1[effect]
	return ok
}

func validCapabilityName(name string) bool {
	if len(name) < 1 || len(name) > 64 || name[0] < 'a' || name[0] > 'z' {
		return false
	}
	for i := 1; i < len(name); i++ {
		c := name[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

func validateCanonicalEffects(version int, effects []string) error {
	if len(effects) == 0 {
		if version != 0 {
			return fmt.Errorf("pure effect metadata must omit effect_version")
		}
		return nil
	}
	if version != EffectVersion {
		return fmt.Errorf("effect metadata requires version %d", EffectVersion)
	}
	if len(effects) > MaxEffects {
		return fmt.Errorf("effect count exceeds %d", MaxEffects)
	}
	for i, effect := range effects {
		if !knownEffect(effect) {
			return fmt.Errorf("unknown effect %q", effect)
		}
		if i > 0 && effects[i-1] >= effect {
			if effects[i-1] == effect {
				return fmt.Errorf("duplicate effect %q", effect)
			}
			return fmt.Errorf("effects are not in canonical order")
		}
	}
	return nil
}

func capabilityKey(c CapabilityRequirement) string { return c.Effect + "\x00" + c.Name }

func validateFunctionEffects(f Function) error {
	if err := validateCanonicalEffects(f.EffectVersion, f.Effects); err != nil {
		return err
	}
	if len(f.Effects) == 0 {
		if len(f.RequiredCapabilities) != 0 {
			return fmt.Errorf("pure function cannot require capabilities")
		}
		return nil
	}
	if len(f.RequiredCapabilities) == 0 || len(f.RequiredCapabilities) > MaxCapabilities {
		return fmt.Errorf("effectful function requires 1..%d capabilities", MaxCapabilities)
	}
	effectSet := make(map[string]bool, len(f.Effects))
	covered := make(map[string]bool, len(f.Effects))
	for _, effect := range f.Effects {
		effectSet[effect] = true
	}
	names := make(map[string]bool, len(f.RequiredCapabilities))
	for i, capability := range f.RequiredCapabilities {
		if !validCapabilityName(capability.Name) {
			return fmt.Errorf("malformed capability requirement name %q", capability.Name)
		}
		if names[capability.Name] {
			return fmt.Errorf("duplicate capability requirement %q", capability.Name)
		}
		names[capability.Name] = true
		if !knownEffect(capability.Effect) || !effectSet[capability.Effect] {
			return fmt.Errorf("capability %q references undeclared effect %q", capability.Name, capability.Effect)
		}
		covered[capability.Effect] = true
		if i > 0 {
			previous := capabilityKey(f.RequiredCapabilities[i-1])
			current := capabilityKey(capability)
			if previous >= current {
				return fmt.Errorf("required_capabilities are not in canonical order")
			}
		}
	}
	for _, effect := range f.Effects {
		if !covered[effect] {
			return fmt.Errorf("effect %q has no capability requirement", effect)
		}
	}
	return nil
}

func validateEffectPropagation(caller, callee Function) error {
	if len(callee.Effects) == 0 {
		return nil
	}
	effects := make(map[string]bool, len(caller.Effects))
	for _, effect := range caller.Effects {
		effects[effect] = true
	}
	for _, effect := range callee.Effects {
		if !effects[effect] {
			return fmt.Errorf("call to %s requires propagated effect %q", callee.Name, effect)
		}
	}
	capabilities := make(map[CapabilityRequirement]bool, len(caller.RequiredCapabilities))
	for _, capability := range caller.RequiredCapabilities {
		capabilities[capability] = true
	}
	for _, capability := range callee.RequiredCapabilities {
		if !capabilities[capability] {
			return fmt.Errorf("call to %s requires propagated capability %q", callee.Name, capability.Name)
		}
	}
	return nil
}

func semanticsForFunction(f Function) FunctionSemantics {
	semantics := FunctionSemantics{Purity: "pure"}
	if len(f.Effects) == 0 {
		return semantics
	}
	semantics.Purity = "effectful"
	semantics.EffectVersion = f.EffectVersion
	semantics.Effects = append([]string(nil), f.Effects...)
	semantics.RequiredCapabilities = append([]CapabilityRequirement(nil), f.RequiredCapabilities...)
	return semantics
}

func effectsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// CanonicalEffectRegistry returns the Effect ABI v1 registry in stable order.
func CanonicalEffectRegistry() []string {
	effects := make([]string, 0, len(effectRegistryV1))
	for effect := range effectRegistryV1 {
		effects = append(effects, effect)
	}
	sort.Strings(effects)
	return effects
}
