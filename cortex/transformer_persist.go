package cortex

// transformer_persist.go — Save/Load for MiniTransformer.
//
// Persists every learnable tensor of the model (token+positional embeddings,
// per-block attention weights and biases, FFN weights and biases, LayerNorm
// gammas and betas, plus the final LN parameters) so that training survives
// process restarts. Gradient accumulators are NOT serialised — they are
// transient and re-initialised on load.
//
// Format: gzip-compressed JSON. The top-level struct carries the Config and
// the full weight payload; LoadMiniTransformer reconstructs the in-memory
// graph deterministically from this dump.

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
)

// tensorJSON is a minimal serialisable view of a Tensor.
type tensorJSON struct {
	Shape []int     `json:"shape"`
	Data  []float32 `json:"data"`
}

func tensorToJSON(t *Tensor) tensorJSON {
	if t == nil {
		return tensorJSON{}
	}
	return tensorJSON{Shape: append([]int(nil), t.Shape...), Data: append([]float32(nil), t.Data...)}
}

func tensorFromJSON(j tensorJSON) *Tensor {
	if len(j.Shape) == 0 {
		return nil
	}
	t := NewTensor(j.Shape...)
	if len(j.Data) == len(t.Data) {
		copy(t.Data, j.Data)
	}
	return t
}

// mhaJSON serialises one MultiHeadAttention block (weights + biases only).
type mhaJSON struct {
	WQ, WK, WV, WO tensorJSON
	BQ, BK, BV, BO tensorJSON
}

// ffnJSON serialises one FeedForward block (weights + biases only).
// W3/B3 are empty for GELU FFNs and only populated under SwiGLU.
type ffnJSON struct {
	W1, B1 tensorJSON
	W2, B2 tensorJSON
	W3, B3 tensorJSON
}

// blockJSON serialises one TransformerBlock.
type blockJSON struct {
	Attn     mhaJSON
	FFN      ffnJSON
	LN1Gamma tensorJSON
	LN1Beta  tensorJSON
	LN2Gamma tensorJSON
	LN2Beta  tensorJSON
}

// transformerFileJSON is the top-level on-disk representation.
type transformerFileJSON struct {
	Version  int               `json:"version"`
	Config   TransformerConfig `json:"config"`
	TokenEmb tensorJSON        `json:"token_emb"`
	PosEmb   tensorJSON        `json:"pos_emb"`
	Blocks   []blockJSON       `json:"blocks"`
	LNFGamma tensorJSON        `json:"lnf_gamma"`
	LNFBeta  tensorJSON        `json:"lnf_beta"`
	UseTied  bool              `json:"use_tied_weights"`
}

const transformerPersistVersion = 1

// Save writes the transformer weights to path (gzip+JSON, 0600 perms).
func (m *MiniTransformer) Save(path string) error {
	if m == nil {
		return fmt.Errorf("nil transformer")
	}

	dump := transformerFileJSON{
		Version:  transformerPersistVersion,
		Config:   m.Config,
		TokenEmb: tensorToJSON(m.Embedding.TokenEmb),
		PosEmb:   tensorToJSON(m.Embedding.PosEmb),
		LNFGamma: tensorToJSON(m.LNFGamma),
		LNFBeta:  tensorToJSON(m.LNFBeta),
		UseTied:  m.UseTiedWeights,
		Blocks:   make([]blockJSON, len(m.Blocks)),
	}

	for i, b := range m.Blocks {
		dump.Blocks[i] = blockJSON{
			Attn: mhaJSON{
				WQ: tensorToJSON(b.Attn.WQ), WK: tensorToJSON(b.Attn.WK),
				WV: tensorToJSON(b.Attn.WV), WO: tensorToJSON(b.Attn.WO),
				BQ: tensorToJSON(b.Attn.BQ), BK: tensorToJSON(b.Attn.BK),
				BV: tensorToJSON(b.Attn.BV), BO: tensorToJSON(b.Attn.BO),
			},
			FFN: ffnJSON{
				W1: tensorToJSON(b.FFN.W1), B1: tensorToJSON(b.FFN.B1),
				W2: tensorToJSON(b.FFN.W2), B2: tensorToJSON(b.FFN.B2),
				W3: tensorToJSON(b.FFN.W3), B3: tensorToJSON(b.FFN.B3),
			},
			LN1Gamma: tensorToJSON(b.LN1Gamma),
			LN1Beta:  tensorToJSON(b.LN1Beta),
			LN2Gamma: tensorToJSON(b.LN2Gamma),
			LN2Beta:  tensorToJSON(b.LN2Beta),
		}
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmp, err)
	}

	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(&dump); err != nil {
		_ = gz.Close()
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("encode: %w", err)
	}
	if err := gz.Close(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("gzip close: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// LoadMiniTransformer reconstructs a transformer from disk. Returns nil
// transformer and a nil error when the file does not exist (caller is
// expected to fall back to fresh initialisation in that case).
//
// Both persisted formats are accepted, dispatched by magic bytes:
// "NXTF2BIN" → binary v2 (transformer_persist_binary.go), gzip magic →
// the original JSON v1.
func LoadMiniTransformer(path string, rng *rand.Rand) (*MiniTransformer, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, 1<<20)
	magic, err := br.Peek(len(nxtf2Magic))
	if err == nil && string(magic) == string(nxtf2Magic[:]) {
		if _, err := br.Discard(len(nxtf2Magic)); err != nil {
			return nil, err
		}
		return loadMiniTransformerBinary(br, rng)
	}

	gz, err := gzip.NewReader(br)
	if err != nil {
		return nil, fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	raw, err := io.ReadAll(gz)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	var dump transformerFileJSON
	if err := json.Unmarshal(raw, &dump); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if dump.Version != transformerPersistVersion {
		return nil, fmt.Errorf("unsupported transformer persist version %d (want %d)", dump.Version, transformerPersistVersion)
	}

	// Build a fresh transformer with the persisted config, then overwrite weights.
	m := NewMiniTransformer(dump.Config, rng)

	if t := tensorFromJSON(dump.TokenEmb); t != nil {
		m.Embedding.TokenEmb = t
	}
	if t := tensorFromJSON(dump.PosEmb); t != nil {
		m.Embedding.PosEmb = t
	}
	if t := tensorFromJSON(dump.LNFGamma); t != nil {
		m.LNFGamma = t
	}
	if t := tensorFromJSON(dump.LNFBeta); t != nil {
		m.LNFBeta = t
	}
	m.UseTiedWeights = dump.UseTied

	if len(dump.Blocks) != len(m.Blocks) {
		return nil, fmt.Errorf("block count mismatch: file=%d, config=%d", len(dump.Blocks), len(m.Blocks))
	}
	for i, bj := range dump.Blocks {
		b := m.Blocks[i]
		if t := tensorFromJSON(bj.Attn.WQ); t != nil {
			b.Attn.WQ = t
		}
		if t := tensorFromJSON(bj.Attn.WK); t != nil {
			b.Attn.WK = t
		}
		if t := tensorFromJSON(bj.Attn.WV); t != nil {
			b.Attn.WV = t
		}
		if t := tensorFromJSON(bj.Attn.WO); t != nil {
			b.Attn.WO = t
		}
		if t := tensorFromJSON(bj.Attn.BQ); t != nil {
			b.Attn.BQ = t
		}
		if t := tensorFromJSON(bj.Attn.BK); t != nil {
			b.Attn.BK = t
		}
		if t := tensorFromJSON(bj.Attn.BV); t != nil {
			b.Attn.BV = t
		}
		if t := tensorFromJSON(bj.Attn.BO); t != nil {
			b.Attn.BO = t
		}
		if t := tensorFromJSON(bj.FFN.W1); t != nil {
			b.FFN.W1 = t
		}
		if t := tensorFromJSON(bj.FFN.B1); t != nil {
			b.FFN.B1 = t
		}
		if t := tensorFromJSON(bj.FFN.W2); t != nil {
			b.FFN.W2 = t
		}
		if t := tensorFromJSON(bj.FFN.B2); t != nil {
			b.FFN.B2 = t
		}
		// SwiGLU gate: NewMiniTransformer already allocated W3/B3 when
		// the persisted config carries UseSwiGLU — just overwrite.
		if t := tensorFromJSON(bj.FFN.W3); t != nil {
			b.FFN.W3 = t
		}
		if t := tensorFromJSON(bj.FFN.B3); t != nil {
			b.FFN.B3 = t
		}
		if t := tensorFromJSON(bj.LN1Gamma); t != nil {
			b.LN1Gamma = t
		}
		if t := tensorFromJSON(bj.LN1Beta); t != nil {
			b.LN1Beta = t
		}
		if t := tensorFromJSON(bj.LN2Gamma); t != nil {
			b.LN2Gamma = t
		}
		if t := tensorFromJSON(bj.LN2Beta); t != nil {
			b.LN2Beta = t
		}
	}

	return m, nil
}
