package cortex

import (
	"flag"
	"nexus-cortex/internal/runtimeguard"
)

// ApplyConfigFlags applies only explicitly provided flag setters, then validates
// the final merged configuration. Call after defaults and JSON configuration.
func ApplyConfigFlags(cfg *Config, fs *flag.FlagSet, setters map[string]func()) error {
	runtimeguard.ApplyExplicit(fs, setters)
	return cfg.Validate()
}
