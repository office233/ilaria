package cortex

import (
	"fmt"
	"math/rand"
	"os"

	"ilaria/internal/runtimeguard"
)

// OpenOrganism loads existing state or creates an organism ONLY in a new/empty
// directory. Corruption is never converted into a fresh organism that later
// overwrites the original. Use a different empty directory for a fresh run.
// The operator must serialize access to a state directory across processes.
func OpenOrganism(cfg Config, rng *rand.Rand) (*Organism, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if rng == nil {
		return nil, fmt.Errorf("organism: nil random source")
	}
	empty, err := runtimeguard.EmptyStateDir(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	if !empty {
		if cfg.Fresh {
			return nil, fmt.Errorf("refusing a fresh organism in non-empty directory %q; choose a new data directory", cfg.DataDir)
		}
		org, err := LoadOrganism(cfg, rng)
		if err != nil {
			return nil, fmt.Errorf("existing state was not loaded; original files preserved: %w", err)
		}
		if org == nil {
			return nil, fmt.Errorf("load returned no organism; original files preserved")
		}
		return org, nil
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	return NewOrganism(cfg, rng), nil
}
