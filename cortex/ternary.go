package cortex

// ternary.go — RGBA32 Ternary Computation Engine
//
// Implements BitNet b1.58-style ternary weights {-1, 0, +1} packed into
// RGBA32 pixels. This enables:
//   - 16 ternary weights per 4-byte RGBA32 pixel
//   - Forward pass using ONLY addition and subtraction (zero multiplication)
//   - Native sparsity: weight=0 means skip computation entirely
//   - GPU-texture-compatible memory layout
//
// Packing format per RGBA32 pixel (4 bytes = 32 bits = 16 weights):
//   R byte (8 bits): sign bits for weights 0-7  (0=positive, 1=negative)
//   G byte (8 bits): mask bits for weights 0-7  (0=zero/skip, 1=active)
//   B byte (8 bits): sign bits for weights 8-15
//   A byte (8 bits): mask bits for weights 8-15
//
// Weight encoding:
//   mask=0         → weight is 0 (skip computation — free sparsity!)
//   mask=1, sign=0 → weight is +1
//   mask=1, sign=1 → weight is -1

import (
	"encoding/binary"
	"fmt"
	"math/bits"
	"unsafe"
)

// TernaryTile holds 16 ternary weights packed into a single RGBA32 pixel.
// This is the atomic unit of the ternary computation engine.
type TernaryTile uint32

// PackTernaryTile creates a TernaryTile from 16 ternary weights.
// Each weight must be -1, 0, or +1.
func PackTernaryTile(weights [16]int8) TernaryTile {
	var signLo, maskLo, signHi, maskHi uint8

	for i := 0; i < 8; i++ {
		w := weights[i]
		if w != 0 {
			maskLo |= 1 << uint(i)
			if w < 0 {
				signLo |= 1 << uint(i)
			}
		}
	}

	for i := 0; i < 8; i++ {
		w := weights[8+i]
		if w != 0 {
			maskHi |= 1 << uint(i)
			if w < 0 {
				signHi |= 1 << uint(i)
			}
		}
	}

	// Pack as RGBA: R=signLo, G=maskLo, B=signHi, A=maskHi
	return TernaryTile(uint32(signLo) | uint32(maskLo)<<8 | uint32(signHi)<<16 | uint32(maskHi)<<24)
}

// UnpackTernaryTile extracts 16 ternary weights from a TernaryTile.
func (t TernaryTile) Unpack() [16]int8 {
	var out [16]int8
	v := uint32(t)
	signLo := uint8(v)
	maskLo := uint8(v >> 8)
	signHi := uint8(v >> 16)
	maskHi := uint8(v >> 24)

	for i := 0; i < 8; i++ {
		bit := uint8(1 << uint(i))
		if maskLo&bit != 0 {
			if signLo&bit != 0 {
				out[i] = -1
			} else {
				out[i] = 1
			}
		}
	}

	for i := 0; i < 8; i++ {
		bit := uint8(1 << uint(i))
		if maskHi&bit != 0 {
			if signHi&bit != 0 {
				out[8+i] = -1
			} else {
				out[8+i] = 1
			}
		}
	}
	return out
}

// Sparsity returns the fraction of zero weights (0.0 to 1.0 as fixed-point 0-255).
func (t TernaryTile) Sparsity() uint8 {
	v := uint32(t)
	maskLo := uint8(v >> 8)
	maskHi := uint8(v >> 24)
	active := bits.OnesCount8(maskLo) + bits.OnesCount8(maskHi)
	return uint8(((16 - active) * 255) / 16)
}

// ActiveCount returns the number of non-zero weights in this tile.
func (t TernaryTile) ActiveCount() int {
	v := uint32(t)
	maskLo := uint8(v >> 8)
	maskHi := uint8(v >> 24)
	return bits.OnesCount8(maskLo) + bits.OnesCount8(maskHi)
}

// RGBA32Bytes returns the tile as 4 bytes in RGBA order for GPU texture upload.
func (t TernaryTile) RGBA32Bytes() [4]byte {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], uint32(t))
	return b
}

// TernaryTileFromRGBA32 creates a tile from raw RGBA32 bytes.
func TernaryTileFromRGBA32(b [4]byte) TernaryTile {
	return TernaryTile(binary.LittleEndian.Uint32(b[:]))
}

// ---------------------------------------------------------------------------
// TernaryLayer — A fully-connected layer with RGBA32 ternary weights
// ---------------------------------------------------------------------------

// TernaryLayer represents a neural network layer where all weights are
// ternary {-1, 0, +1} packed into RGBA32 tiles.
//
// For a layer with inputSize=1024 and outputSize=512:
//
//	Each output neuron needs 1024 weights = 64 tiles (16 weights per tile)
//	Total tiles: 512 * 64 = 32,768 tiles = 128 KB
//	Equivalent float32 layer: 1024 * 512 * 4 = 2 MB (16x more memory!)
type TernaryLayer struct {
	InputSize   int
	OutputSize  int
	TilesPerRow int           // = ceil(InputSize / 16)
	Tiles       []TernaryTile // [OutputSize * TilesPerRow] tiles
	Bias        []int16       // [OutputSize] bias per output neuron (optional)

	// PRNGState seed-uiește xorshift-ul folosit de UpdateProbabilisticSTDP.
	// Setat din cfg.Seed pentru reproductibilitate. Niciodata 0 (PRNG-ul nu
	// poate avansa din 0); valoarea 0 înseamnă "uninitialized" și e tratată
	// ca seed=1 la prima utilizare.
	PRNGState uint64 `json:"prng_state,omitempty"`

	// Engine is an optional hardware accelerator (e.g., GPU/WebGPU).
	// If set, ForwardSparse is offloaded to the engine.
	Engine interface{} `json:"-"`
}

// SeedPRNG inițializează state-ul xorshift folosit de antrenarea STDP.
// Apelat o singură dată după construire, cu cfg.Seed (sau orice valoare
// reproductibilă). Garantează state != 0.
func (l *TernaryLayer) SeedPRNG(seed int64) {
	s := uint64(seed)
	if s == 0 {
		s = 1
	}
	l.PRNGState = s
}

// NewTernaryLayer creates a new ternary layer with zero-initialized weights.
func NewTernaryLayer(inputSize, outputSize int) *TernaryLayer {
	tilesPerRow := (inputSize + 15) / 16
	return &TernaryLayer{
		InputSize:   inputSize,
		OutputSize:  outputSize,
		TilesPerRow: tilesPerRow,
		Tiles:       make([]TernaryTile, outputSize*tilesPerRow),
		Bias:        make([]int16, outputSize),
	}
}

// SetWeight sets a single weight at position (outputIdx, inputIdx) to value v.
// v must be -1, 0, or +1.
func (l *TernaryLayer) SetWeight(outputIdx, inputIdx int, v int8) {
	tileIdx := outputIdx*l.TilesPerRow + inputIdx/16
	pos := inputIdx % 16

	weights := l.Tiles[tileIdx].Unpack()
	weights[pos] = v
	l.Tiles[tileIdx] = PackTernaryTile(weights)
}

// GetWeight returns the weight at position (outputIdx, inputIdx).
func (l *TernaryLayer) GetWeight(outputIdx, inputIdx int) int8 {
	tileIdx := outputIdx*l.TilesPerRow + inputIdx/16
	pos := inputIdx % 16
	return l.Tiles[tileIdx].Unpack()[pos]
}

// Forward performs the forward pass using ONLY addition and subtraction.
// ZERO multiplication. This is the core of the RGBA32 ternary engine.
//
// For each output neuron j:
//
//	output[j] = bias[j] + Σ(input[i] * weight[j][i])
//	But since weight ∈ {-1, 0, +1}:
//	  weight = +1: output[j] += input[i]
//	  weight = -1: output[j] -= input[i]
//	  weight =  0: skip (free sparsity!)
//
// The computation uses bit manipulation:
//
//	positive_mask = mask AND NOT sign  (bits where weight = +1)
//	negative_mask = mask AND sign      (bits where weight = -1)
//	For each active positive bit: output += input
//	For each active negative bit: output -= input
func (l *TernaryLayer) Forward(input []int16) []int16 {
	output := make([]int16, l.OutputSize)
	copy(output, l.Bias)

	for j := 0; j < l.OutputSize; j++ {
		var acc int32 // Use int32 to prevent overflow during accumulation
		rowOffset := j * l.TilesPerRow

		for t := 0; t < l.TilesPerRow; t++ {
			tile := uint32(l.Tiles[rowOffset+t])
			signLo := uint8(tile)
			maskLo := uint8(tile >> 8)
			signHi := uint8(tile >> 16)
			maskHi := uint8(tile >> 24)

			// Process lower 8 weights
			posLo := maskLo &^ signLo // mask AND NOT sign = positive weights
			negLo := maskLo & signLo  // mask AND sign = negative weights

			baseIdx := t * 16
			// Process positive weights (ADD)
			for posLo != 0 {
				bit := posLo & (-posLo) // isolate lowest set bit
				idx := baseIdx + bits.TrailingZeros8(bit)
				if idx < l.InputSize {
					acc += int32(input[idx])
				}
				posLo ^= bit // clear lowest set bit
			}
			// Process negative weights (SUB)
			for negLo != 0 {
				bit := negLo & (-negLo)
				idx := baseIdx + bits.TrailingZeros8(bit)
				if idx < l.InputSize {
					acc -= int32(input[idx])
				}
				negLo ^= bit
			}

			// Process upper 8 weights
			posHi := maskHi &^ signHi
			negHi := maskHi & signHi

			for posHi != 0 {
				bit := posHi & (-posHi)
				idx := baseIdx + 8 + bits.TrailingZeros8(bit)
				if idx < l.InputSize {
					acc += int32(input[idx])
				}
				posHi ^= bit
			}
			for negHi != 0 {
				bit := negHi & (-negHi)
				idx := baseIdx + 8 + bits.TrailingZeros8(bit)
				if idx < l.InputSize {
					acc -= int32(input[idx])
				}
				negHi ^= bit
			}
		}

		// Clamp to int16 range
		if acc > 32767 {
			acc = 32767
		} else if acc < -32768 {
			acc = -32768
		}
		output[j] += int16(acc)
	}

	return output
}

// ForwardSparse performs forward pass on SPARSE input (SDR-style).
// Only processes input positions that are non-zero — much faster when
// input sparsity is high (e.g., SDR with 0.5% active bits).
//
// Returns (output, nil) on success, or (nil, error) for invalid input.
func (l *TernaryLayer) ForwardSparse(activeIndices []int, activeValues []int16) ([]int16, error) {
	if l.InputSize <= 0 || l.OutputSize <= 0 || len(l.Tiles) == 0 {
		return nil, fmt.Errorf("ternary: invalid layer (input=%d output=%d tiles=%d)", l.InputSize, l.OutputSize, len(l.Tiles))
	}
	if len(activeIndices) != len(activeValues) {
		return nil, fmt.Errorf("ternary: mismatched activeIndices(%d) and activeValues(%d)", len(activeIndices), len(activeValues))
	}
	for _, idx := range activeIndices {
		if idx < 0 || idx >= l.InputSize {
			return nil, fmt.Errorf("ternary: index %d out of range [0, %d)", idx, l.InputSize)
		}
	}

	output := make([]int16, l.OutputSize)
	copy(output, l.Bias)

	if l.Engine != nil {
		// Delegate to hardware engine (returns error instead of panicking)
		if eng, ok := l.Engine.(interface {
			ForwardSparse([]uint32, []int16, []uint32, []int16, int, int) ([]int16, error)
		}); ok {
			indices32 := make([]uint32, len(activeIndices))
			for i, v := range activeIndices {
				indices32[i] = uint32(v)
			}
			tiles32 := unsafe.Slice((*uint32)(unsafe.Pointer(&l.Tiles[0])), len(l.Tiles))
			result, err := eng.ForwardSparse(indices32, activeValues, tiles32, l.Bias, l.TilesPerRow, l.OutputSize)
			if err == nil {
				return result, nil
			}
			// Engine failed — fall through to CPU path.
		}
	}

	for j := 0; j < l.OutputSize; j++ {
		var acc int32
		rowOffset := j * l.TilesPerRow
		for k, idx := range activeIndices {
			tileIdx := rowOffset + idx/16
			pos := idx % 16
			tile := uint32(l.Tiles[tileIdx])
			var sign, mask uint8
			if pos < 8 {
				sign = uint8(tile)
				mask = uint8(tile >> 8)
			} else {
				sign = uint8(tile >> 16)
				mask = uint8(tile >> 24)
				pos -= 8
			}
			bit := uint8(1 << uint(pos))
			if mask&bit != 0 {
				if sign&bit != 0 {
					acc -= int32(activeValues[k])
				} else {
					acc += int32(activeValues[k])
				}
			}
		}
		if acc > 32767 {
			acc = 32767
		} else if acc < -32768 {
			acc = -32768
		}
		output[j] += int16(acc)
	}

	return output, nil
}

// MemoryBytes returns the total memory used by this layer in bytes.
func (l *TernaryLayer) MemoryBytes() int {
	return len(l.Tiles)*4 + len(l.Bias)*2
}

// ParameterCount returns the total number of ternary parameters.
func (l *TernaryLayer) ParameterCount() int {
	return l.OutputSize * l.InputSize
}

// Sparsity returns the average sparsity across all tiles (0.0 = all active, 1.0 = all zero).
func (l *TernaryLayer) SparsityRatio() float64 {
	if len(l.Tiles) == 0 {
		return 0
	}
	totalActive := 0
	totalPossible := len(l.Tiles) * 16
	for _, t := range l.Tiles {
		totalActive += t.ActiveCount()
	}
	return 1.0 - float64(totalActive)/float64(totalPossible)
}

// Stats returns a human-readable summary of the layer.
func (l *TernaryLayer) Stats() string {
	memKB := float64(l.MemoryBytes()) / 1024
	paramM := float64(l.ParameterCount()) / 1_000_000
	return fmt.Sprintf("TernaryLayer[%dx%d] params=%.2fM mem=%.1fKB sparsity=%.1f%%",
		l.InputSize, l.OutputSize, paramM, memKB, l.SparsityRatio()*100)
}

// ---------------------------------------------------------------------------
// RGBA32 Serialization — Save/Load ternary layers as RGBA32 binary
// ---------------------------------------------------------------------------

// MarshalRGBA32 serializes the layer to RGBA32 binary format.
// Format: [magic:4][inputSize:4][outputSize:4][biases:2*outputSize][tiles:4*N]
func (l *TernaryLayer) MarshalRGBA32() []byte {
	headerSize := 12 + len(l.Bias)*2
	totalSize := headerSize + len(l.Tiles)*4
	buf := make([]byte, totalSize)

	// Magic: "NXT1" (Ilaria Ternary v1)
	copy(buf[0:4], []byte("NXT1"))
	binary.LittleEndian.PutUint32(buf[4:8], uint32(l.InputSize))
	binary.LittleEndian.PutUint32(buf[8:12], uint32(l.OutputSize))

	// Biases
	offset := 12
	for _, b := range l.Bias {
		binary.LittleEndian.PutUint16(buf[offset:offset+2], uint16(b))
		offset += 2
	}

	// Tiles
	for _, t := range l.Tiles {
		binary.LittleEndian.PutUint32(buf[offset:offset+4], uint32(t))
		offset += 4
	}

	return buf
}

// UnmarshalTernaryLayer deserializes a TernaryLayer from RGBA32 binary format.
func UnmarshalTernaryLayer(data []byte) (*TernaryLayer, error) {
	if len(data) < 12 {
		return nil, fmt.Errorf("ternary layer data too short: %d bytes", len(data))
	}
	if string(data[0:4]) != "NXT1" {
		return nil, fmt.Errorf("invalid ternary layer magic: %q", string(data[0:4]))
	}

	inputSize := int(binary.LittleEndian.Uint32(data[4:8]))
	outputSize := int(binary.LittleEndian.Uint32(data[8:12]))

	const maxDim = 100_000
	if inputSize <= 0 || outputSize <= 0 || inputSize > maxDim || outputSize > maxDim {
		return nil, fmt.Errorf("invalid layer dimensions: input=%d output=%d", inputSize, outputSize)
	}

	tilesPerRow := (inputSize + 15) / 16
	expectedSize := 12 + outputSize*2 + outputSize*tilesPerRow*4
	if expectedSize < 12 || expectedSize > len(data) {
		return nil, fmt.Errorf("ternary layer data length mismatch: got=%d expected=%d", len(data), expectedSize)
	}

	l := NewTernaryLayer(inputSize, outputSize)

	offset := 12
	for i := 0; i < outputSize; i++ {
		l.Bias[i] = int16(binary.LittleEndian.Uint16(data[offset : offset+2]))
		offset += 2
	}

	for i := range l.Tiles {
		l.Tiles[i] = TernaryTile(binary.LittleEndian.Uint32(data[offset : offset+4]))
		offset += 4
	}

	return l, nil
}
