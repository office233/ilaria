package cortex

import "testing"

// Tests of memory, provenance and persistence do not need to allocate and
// serialize 500M unrelated fractal weights. Preserve their normal SDR settings.
func organismTestConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	cfg.DisableFractalCortex = true
	return cfg
}

// Fractal-specific tests retain the real subsystem at a small matrix size.
func fractalTestConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	cfg.SDRSize = 512
	cfg.FractalNumLayers = 2
	return cfg
}
