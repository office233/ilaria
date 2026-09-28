package compute

// Engine defines the interface for hardware-accelerated computation
// of the Ilaria neural primitives.
//
// All methods return errors instead of panicking, allowing callers
// to fall back to CPU gracefully.
type Engine interface {
	// Init initializes the compute engine (e.g., allocates buffers, compiles shaders).
	Init() error

	// Close releases any hardware resources held by the engine.
	Close()

	// ForwardSparse computes the activation of a ternary layer given sparse inputs.
	// activeIndices and activeValues represent the non-zero inputs.
	// tiles is the array of TernaryTile (uint32).
	// bias is the array of bias per output neuron.
	// tilesPerRow is ceil(InputSize / 16).
	//
	// Returns (output, nil) on success, or (nil, error) on failure.
	// Callers MUST fall back to CPU on error.
	ForwardSparse(activeIndices []uint32, activeValues []int16, tiles []uint32, bias []int16, tilesPerRow int, outputSize int) ([]int16, error)

	// BatchSDRSimilarity computes the intersection size between a query SDR
	// and a batch of memory SDRs in parallel.
	//
	// Returns (results, nil) on success, or (nil, error) on failure.
	BatchSDRSimilarity(querySDR []uint32, memorySDRs [][]uint32) ([]uint8, error)
}
