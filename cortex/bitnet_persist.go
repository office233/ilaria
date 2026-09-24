package cortex

// bitnet_persist.go — loads the NXTF v3 checkpoint format
// (forge/import_bitnet.py) into a *BitNetModel (cortex/bitnet.go).
//
// Layout (all little-endian), matching NXTF2BIN's spirit but versioned up
// because the tensor set is heterogeneous (f32 norms/embedding + ternary
// BitLinear weights, each carrying its own dequant scale) rather than a
// fixed, all-float32 tensor list:
//
//	magic   [8]byte  "NXTF3BIN"
//	hdrLen  uint32   length of the JSON header that follows
//	header  []byte   JSON: {"version":3,"arch":"bitnet","config":{...},
//	                        "tensors":[{"name","kind","shape","offset",
//	                                    "bytes","scale"?}, ...]}
//	blobs            each tensor's raw bytes, back-to-back; a tensor's
//	                 "offset"/"bytes" fields are relative to the start of
//	                 the blob region (immediately after the header).
//
// kind "f32": raw little-endian float32, row-major over `shape`.
// kind "ternary": raw little-endian uint32 TernaryTile values — EXACTLY
// cortex/ternary.go's PackTernaryTile output, row-major over Out with
// ceil(In/16) tiles per row (shape == [Out, In]) — so the blob can be
// bulk-copied straight into a BitLinear.Tiles slice with no per-element
// unpacking. "scale" is that tensor's BitLinear.Scale (HF's weight_scale;
// convention W ≈ scale·T, see bitnet_linear.go's doc comment).
//
// Tensor names: "embed", "final_norm", and per layer i (0-based)
// "layers.<i>.attn_norm" / "ffn_norm" / "attn_sub_norm" / "ffn_sub_norm"
// (f32) and "layers.<i>.q" / "k" / "v" / "o" / "gate" / "up" / "down"
// (ternary) — must match forge/import_bitnet.py's write_top/write_layer.
//
// Load performance: every tensor is read with a single io.ReadFull into a
// []byte buffer, then decoded with a tight arithmetic loop over
// encoding/binary (no reflection, no per-element file I/O) — bulk enough
// to load the real 2.4B checkpoint (~1.9 GB on disk) in a few seconds.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

var nxtf3Magic = [8]byte{'N', 'X', 'T', 'F', '3', 'B', 'I', 'N'}

// bitnetConfigJSON mirrors BitNetConfig's fields with the snake_case JSON
// tags the NXTF v3 header uses. BitNetConfig itself (cortex/bitnet.go,
// owned by another agent) carries no json tags, so we decode into this
// shadow struct and copy fields across rather than unmarshaling directly
// into BitNetConfig.
type bitnetConfigJSON struct {
	VocabSize  int     `json:"vocab_size"`
	EmbedDim   int     `json:"embed_dim"`
	NumLayers  int     `json:"num_layers"`
	NumHeads   int     `json:"num_heads"`
	NumKVHeads int     `json:"num_kv_heads"`
	FFNDim     int     `json:"ffn_dim"`
	MaxSeqLen  int     `json:"max_seq_len"`
	RopeTheta  float64 `json:"rope_theta"`
	RMSNormEps float64 `json:"rms_norm_eps"`
	EOSTokenID int     `json:"eos_token_id"`
	BOSTokenID int     `json:"bos_token_id"`
}

func (c bitnetConfigJSON) toBitNetConfig() BitNetConfig {
	return BitNetConfig{
		VocabSize:  c.VocabSize,
		EmbedDim:   c.EmbedDim,
		NumLayers:  c.NumLayers,
		NumHeads:   c.NumHeads,
		NumKVHeads: c.NumKVHeads,
		FFNDim:     c.FFNDim,
		MaxSeqLen:  c.MaxSeqLen,
		RopeTheta:  c.RopeTheta,
		RMSNormEps: c.RMSNormEps,
		EOSTokenID: c.EOSTokenID,
		BOSTokenID: c.BOSTokenID,
	}
}

// bitnetTensorJSON is one entry of the NXTF v3 header's "tensors" list.
type bitnetTensorJSON struct {
	Name   string  `json:"name"`
	Kind   string  `json:"kind"` // "f32" | "ternary"
	Shape  []int   `json:"shape"`
	Offset int64   `json:"offset"`
	Bytes  int64   `json:"bytes"`
	Scale  float32 `json:"scale"`
}

type bitnetHeaderJSON struct {
	Version int                `json:"version"`
	Arch    string             `json:"arch"`
	Config  bitnetConfigJSON   `json:"config"`
	Tensors []bitnetTensorJSON `json:"tensors"`
}

// LoadBitNetModel reads an NXTF v3 file written by forge/import_bitnet.py
// and returns a fully-populated *BitNetModel ready for Forward/
// GenerateGreedy. Every tensor named by the header must be present and
// exactly the size NewBitNetModel(header.Config) expects; any mismatch is
// reported as an error (never a silent partial load).
func LoadBitNetModel(path string) (*BitNetModel, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("bitnet: open %s: %w", path, err)
	}
	defer f.Close()

	var magic [8]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return nil, fmt.Errorf("bitnet: read magic: %w", err)
	}
	if magic != nxtf3Magic {
		return nil, fmt.Errorf("bitnet: bad magic %q, want %q", magic, nxtf3Magic)
	}

	var hdrLen uint32
	if err := binary.Read(f, binary.LittleEndian, &hdrLen); err != nil {
		return nil, fmt.Errorf("bitnet: read header length: %w", err)
	}
	const maxHeader = 256 << 20 // 256 MiB is absurdly generous for a JSON header
	if hdrLen == 0 || hdrLen > maxHeader {
		return nil, fmt.Errorf("bitnet: implausible header length %d", hdrLen)
	}
	hdrBuf := make([]byte, hdrLen)
	if _, err := io.ReadFull(f, hdrBuf); err != nil {
		return nil, fmt.Errorf("bitnet: read header: %w", err)
	}

	var hdr bitnetHeaderJSON
	if err := json.Unmarshal(hdrBuf, &hdr); err != nil {
		return nil, fmt.Errorf("bitnet: parse header json: %w", err)
	}
	if hdr.Version != 3 {
		return nil, fmt.Errorf("bitnet: unsupported NXTF version %d, want 3", hdr.Version)
	}
	if hdr.Arch != "bitnet" {
		return nil, fmt.Errorf("bitnet: unsupported arch %q, want %q", hdr.Arch, "bitnet")
	}

	cfg := hdr.Config.toBitNetConfig()
	m := NewBitNetModel(cfg)
	if len(m.Layers) != cfg.NumLayers {
		return nil, fmt.Errorf("bitnet: NewBitNetModel built %d layers, config wants %d", len(m.Layers), cfg.NumLayers)
	}

	// dataStart: the blob region begins right after magic+hdrLen+header.
	dataStart := int64(len(magic)) + 4 + int64(hdrLen)

	byName := make(map[string]bitnetTensorJSON, len(hdr.Tensors))
	for _, t := range hdr.Tensors {
		byName[t.Name] = t
	}

	readTensorBytes := func(name string) ([]byte, bitnetTensorJSON, error) {
		t, ok := byName[name]
		if !ok {
			return nil, t, fmt.Errorf("bitnet: tensor %q missing from NXTF header", name)
		}
		buf := make([]byte, t.Bytes)
		if _, err := f.ReadAt(buf, dataStart+t.Offset); err != nil {
			return nil, t, fmt.Errorf("bitnet: read tensor %q (%d bytes at +%d): %w", name, t.Bytes, t.Offset, err)
		}
		return buf, t, nil
	}

	loadF32 := func(name string, dst []float32) error {
		buf, t, err := readTensorBytes(name)
		if err != nil {
			return err
		}
		if t.Kind != "f32" {
			return fmt.Errorf("bitnet: tensor %q has kind %q, want f32", name, t.Kind)
		}
		if len(buf)%4 != 0 {
			return fmt.Errorf("bitnet: tensor %q byte length %d not a multiple of 4", name, len(buf))
		}
		n := len(buf) / 4
		if n != len(dst) {
			return fmt.Errorf("bitnet: tensor %q has %d float32 values, want %d", name, n, len(dst))
		}
		for i := 0; i < n; i++ {
			dst[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		return nil
	}

	loadTernary := func(name string, bl *BitLinear) error {
		buf, t, err := readTensorBytes(name)
		if err != nil {
			return err
		}
		if t.Kind != "ternary" {
			return fmt.Errorf("bitnet: tensor %q has kind %q, want ternary", name, t.Kind)
		}
		if len(buf)%4 != 0 {
			return fmt.Errorf("bitnet: tensor %q byte length %d not a multiple of 4", name, len(buf))
		}
		n := len(buf) / 4
		if n != len(bl.Tiles) {
			return fmt.Errorf("bitnet: tensor %q has %d tiles, want %d (Out=%d In=%d)", name, n, len(bl.Tiles), bl.Out, bl.In)
		}
		for i := 0; i < n; i++ {
			bl.Tiles[i] = TernaryTile(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		bl.Scale = t.Scale
		return nil
	}

	if err := loadF32("embed", m.Embed); err != nil {
		return nil, err
	}
	if err := loadF32("final_norm", m.FinalNorm); err != nil {
		return nil, err
	}

	for li, layer := range m.Layers {
		p := fmt.Sprintf("layers.%d.", li)
		if err := loadF32(p+"attn_norm", layer.AttnNorm); err != nil {
			return nil, err
		}
		if err := loadF32(p+"ffn_norm", layer.FFNNorm); err != nil {
			return nil, err
		}
		if err := loadF32(p+"attn_sub_norm", layer.AttnSubNorm); err != nil {
			return nil, err
		}
		if err := loadF32(p+"ffn_sub_norm", layer.FFNSubNorm); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"q", layer.Q); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"k", layer.K); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"v", layer.V); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"o", layer.O); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"gate", layer.Gate); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"up", layer.Up); err != nil {
			return nil, err
		}
		if err := loadTernary(p+"down", layer.Down); err != nil {
			return nil, err
		}
	}

	return m, nil
}
