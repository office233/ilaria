package cortex

import (
	"math"
	"math/rand"
)

// ─────────────────────────────────────────────────────────────────────
// Embedding — Token and Positional Embeddings
// ─────────────────────────────────────────────────────────────────────
//
// Provides learned dense vector representations for tokens and positions.
// This is the first layer of the transformer: token IDs are converted
// to continuous vectors that can be processed by attention layers.
//
// The positional embedding encodes sequence position so the transformer
// can distinguish between "cat sat" and "sat cat".

// EmbeddingTable holds both token embeddings and positional embeddings.
type EmbeddingTable struct {
	TokenEmb *Tensor // [VocabSize, EmbedDim]
	PosEmb   *Tensor // [MaxSeqLen, EmbedDim]

	VocabSize  int
	EmbedDim   int
	MaxSeqLen  int
	UnkTokenID int // Fallback token ID for out-of-range IDs (default 1)

	// AddPositional controls whether PosEmb is added to (and its grad
	// accumulated from) the lookup. Set false under RoPE, where position
	// enters through Q/K rotation instead and PosEmb stays untrained.
	AddPositional bool

	// Gradients (accumulated during backward pass)
	TokenEmbGrad *Tensor // [VocabSize, EmbedDim]
	PosEmbGrad   *Tensor // [MaxSeqLen, EmbedDim]
}

// NewEmbeddingTable creates an embedding table with Xavier-initialized weights.
func NewEmbeddingTable(vocabSize, embedDim, maxSeqLen int, rng *rand.Rand, cfgs ...Config) *EmbeddingTable {
	// Xavier initialization: std = 1 / sqrt(embedDim)
	std := float32(1.0 / math.Sqrt(float64(embedDim)))

	unkID := 1
	if len(cfgs) > 0 && cfgs[0].EmbeddingUnkTokenID > 0 {
		unkID = cfgs[0].EmbeddingUnkTokenID
	}

	return &EmbeddingTable{
		TokenEmb:      NewTensorRand(rng, std, vocabSize, embedDim),
		PosEmb:        NewTensorRand(rng, std, maxSeqLen, embedDim),
		VocabSize:     vocabSize,
		EmbedDim:      embedDim,
		MaxSeqLen:     maxSeqLen,
		UnkTokenID:    unkID,
		AddPositional: true,
		TokenEmbGrad:  NewTensor(vocabSize, embedDim),
		PosEmbGrad:    NewTensor(maxSeqLen, embedDim),
	}
}

// Forward converts a sequence of token IDs into dense vectors.
// Input: tokenIDs []int of length seqLen
// Output: *Tensor [seqLen, EmbedDim] = TokenEmb[id] + PosEmb[pos]
func (e *EmbeddingTable) Forward(tokenIDs []int) *Tensor {
	seqLen := len(tokenIDs)
	if seqLen == 0 {
		return NewTensor(0, e.EmbedDim)
	}
	if seqLen > e.MaxSeqLen {
		seqLen = e.MaxSeqLen
		tokenIDs = tokenIDs[:seqLen]
	}

	output := NewTensor(seqLen, e.EmbedDim)

	for pos := 0; pos < seqLen; pos++ {
		id := tokenIDs[pos]
		if id < 0 || id >= e.VocabSize {
			id = e.UnkTokenID // <UNK> fallback
			if id < 0 || id >= e.VocabSize {
				id = 0
			}
		}

		tokOff := id * e.EmbedDim
		posOff := pos * e.EmbedDim
		outOff := pos * e.EmbedDim

		if e.AddPositional {
			for j := 0; j < e.EmbedDim; j++ {
				output.Data[outOff+j] = e.TokenEmb.Data[tokOff+j] + e.PosEmb.Data[posOff+j]
			}
		} else {
			copy(output.Data[outOff:outOff+e.EmbedDim], e.TokenEmb.Data[tokOff:tokOff+e.EmbedDim])
		}
	}

	return output
}

// Backward accumulates gradients for the embedding lookup.
// dOutput is [seqLen, EmbedDim], tokenIDs is the input from Forward.
func (e *EmbeddingTable) Backward(dOutput *Tensor, tokenIDs []int) {
	seqLen := dOutput.Shape[0]

	for pos := 0; pos < seqLen; pos++ {
		id := tokenIDs[pos]
		if id < 0 || id >= e.VocabSize {
			id = e.UnkTokenID // <UNK> fallback
			if id < 0 || id >= e.VocabSize {
				id = 0
			}
		}

		tokOff := id * e.EmbedDim
		posOff := pos * e.EmbedDim
		outOff := pos * e.EmbedDim

		for j := 0; j < e.EmbedDim; j++ {
			grad := dOutput.Data[outOff+j]
			e.TokenEmbGrad.Data[tokOff+j] += grad
			if e.AddPositional {
				e.PosEmbGrad.Data[posOff+j] += grad
			}
		}
	}
}

// ZeroGrad resets all accumulated gradients to zero.
func (e *EmbeddingTable) ZeroGrad() {
	e.TokenEmbGrad.Zeros()
	e.PosEmbGrad.Zeros()
}

// Update applies SGD with the given learning rate.
func (e *EmbeddingTable) Update(lr float32) {
	for i := range e.TokenEmb.Data {
		e.TokenEmb.Data[i] -= lr * e.TokenEmbGrad.Data[i]
	}
	for i := range e.PosEmb.Data {
		e.PosEmb.Data[i] -= lr * e.PosEmbGrad.Data[i]
	}
}

// ParamCount returns the total number of trainable parameters.
func (e *EmbeddingTable) ParamCount() int {
	return e.VocabSize*e.EmbedDim + e.MaxSeqLen*e.EmbedDim
}
