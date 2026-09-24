package cortex

// vision_siglip_persist.go — loaders for the two files
// cortex/vision_siglip.go's tower/projector are built from:
//
//   - LoadSiglipVisionTower reads the NXTF v3 file
//     forge/multimodal/export_tower.py writes (magic "NXTF3BIN",
//     arch "siglip2_vision") — same container format bitnet_persist.go's
//     LoadBitNetModel reads (arch "bitnet"), just a different tensor set:
//     every tensor here is kind "f32" (no ternary weights, no per-tensor
//     scale — the tower runs in plain float32).
//
//   - LoadSiglipProjector reads the safetensors + JSON sidecar pair
//     forge/multimodal/export_adapter.py writes (PREFIX.safetensors +
//     PREFIX.json) — the same format for both a trained stage-1 checkpoint
//     export and the fixed-seed random projector
//     (data/forge/eyes/projector_seed42.safetensors) used before a trained
//     adapter exists. This is a from-scratch minimal safetensors reader
//     (float32 tensors only — the only dtype export_adapter.py ever
//     writes); no safetensors support existed in this package before.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

// ─────────────────────────────────────────────────────────────────────
// Tower: NXTF v3, arch "siglip2_vision"
// ─────────────────────────────────────────────────────────────────────

// siglipConfigJSON mirrors SiglipVisionConfig's fields with the
// snake_case JSON tags forge/multimodal/export_tower.py's NXTF header
// uses (same shadow-struct pattern as bitnet_persist.go's
// bitnetConfigJSON).
type siglipConfigJSON struct {
	ImageSize      int     `json:"image_size"`
	PatchSize      int     `json:"patch_size"`
	Hidden         int     `json:"hidden_size"`
	NumLayers      int     `json:"num_layers"`
	NumHeads       int     `json:"num_heads"`
	Intermediate   int     `json:"intermediate_size"`
	NumChannels    int     `json:"num_channels"`
	NumPositions   int     `json:"num_positions"`
	LayerNormEps   float64 `json:"layer_norm_eps"`
	HiddenAct      string  `json:"hidden_act"`
	HasPoolingHead bool    `json:"has_pooling_head"`
}

func (c siglipConfigJSON) toSiglipVisionConfig() SiglipVisionConfig {
	return SiglipVisionConfig{
		ImageSize:    c.ImageSize,
		PatchSize:    c.PatchSize,
		Hidden:       c.Hidden,
		NumLayers:    c.NumLayers,
		NumHeads:     c.NumHeads,
		Intermediate: c.Intermediate,
		NumChannels:  c.NumChannels,
		NumPositions: c.NumPositions,
		LayerNormEps: c.LayerNormEps,
		HiddenAct:    c.HiddenAct,
	}
}

type siglipTensorJSON struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"` // always "f32" for this arch
	Shape  []int  `json:"shape"`
	Offset int64  `json:"offset"`
	Bytes  int64  `json:"bytes"`
}

type siglipHeaderJSON struct {
	Version int                `json:"version"`
	Arch    string             `json:"arch"`
	Config  siglipConfigJSON   `json:"config"`
	Tensors []siglipTensorJSON `json:"tensors"`
}

// LoadSiglipVisionTower reads an NXTF v3 file written by
// forge/multimodal/export_tower.py (arch "siglip2_vision") and returns a
// fully-populated *SiglipVisionTower. Every tensor the header lists must
// be present and exactly the size NewSiglipVisionTower(header.Config)
// expects; any mismatch is reported as an error, never a silent partial
// load — same contract as bitnet_persist.go's LoadBitNetModel.
func LoadSiglipVisionTower(path string) (*SiglipVisionTower, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("siglip: open %s: %w", path, err)
	}
	defer f.Close()

	var magic [8]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return nil, fmt.Errorf("siglip: read magic: %w", err)
	}
	if magic != nxtf3Magic {
		return nil, fmt.Errorf("siglip: bad magic %q, want %q", magic, nxtf3Magic)
	}

	var hdrLen uint32
	if err := binary.Read(f, binary.LittleEndian, &hdrLen); err != nil {
		return nil, fmt.Errorf("siglip: read header length: %w", err)
	}
	const maxHeader = 256 << 20
	if hdrLen == 0 || hdrLen > maxHeader {
		return nil, fmt.Errorf("siglip: implausible header length %d", hdrLen)
	}
	hdrBuf := make([]byte, hdrLen)
	if _, err := io.ReadFull(f, hdrBuf); err != nil {
		return nil, fmt.Errorf("siglip: read header: %w", err)
	}

	var hdr siglipHeaderJSON
	if err := json.Unmarshal(hdrBuf, &hdr); err != nil {
		return nil, fmt.Errorf("siglip: parse header json: %w", err)
	}
	if hdr.Version != 3 {
		return nil, fmt.Errorf("siglip: unsupported NXTF version %d, want 3", hdr.Version)
	}
	if hdr.Arch != "siglip2_vision" {
		return nil, fmt.Errorf("siglip: unsupported arch %q, want %q", hdr.Arch, "siglip2_vision")
	}
	if hdr.Config.HasPoolingHead {
		return nil, fmt.Errorf("siglip: has_pooling_head=true not supported (Go loader never loads/uses the pooling head — the multimodal adapter only reads last_hidden_state)")
	}
	if hdr.Config.HiddenAct != "gelu_pytorch_tanh" {
		return nil, fmt.Errorf("siglip: unsupported hidden_act %q, want %q", hdr.Config.HiddenAct, "gelu_pytorch_tanh")
	}

	cfg := hdr.Config.toSiglipVisionConfig()
	m := NewSiglipVisionTower(cfg)

	dataStart := int64(len(magic)) + 4 + int64(hdrLen)
	byName := make(map[string]siglipTensorJSON, len(hdr.Tensors))
	for _, t := range hdr.Tensors {
		byName[t.Name] = t
	}

	loadF32 := func(name string, dst []float32) error {
		t, ok := byName[name]
		if !ok {
			return fmt.Errorf("siglip: tensor %q missing from NXTF header", name)
		}
		if t.Kind != "f32" {
			return fmt.Errorf("siglip: tensor %q has kind %q, want f32", name, t.Kind)
		}
		buf := make([]byte, t.Bytes)
		if _, err := f.ReadAt(buf, dataStart+t.Offset); err != nil {
			return fmt.Errorf("siglip: read tensor %q (%d bytes at +%d): %w", name, t.Bytes, t.Offset, err)
		}
		if len(buf)%4 != 0 {
			return fmt.Errorf("siglip: tensor %q byte length %d not a multiple of 4", name, len(buf))
		}
		n := len(buf) / 4
		if n != len(dst) {
			return fmt.Errorf("siglip: tensor %q has %d float32 values, want %d", name, n, len(dst))
		}
		for i := 0; i < n; i++ {
			dst[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		return nil
	}

	if err := loadF32("embeddings.patch_embedding.weight", m.PatchEmbedWeight); err != nil {
		return nil, err
	}
	if err := loadF32("embeddings.patch_embedding.bias", m.PatchEmbedBias); err != nil {
		return nil, err
	}
	if err := loadF32("embeddings.position_embedding.weight", m.PositionEmbed); err != nil {
		return nil, err
	}

	for li, layer := range m.Layers {
		p := fmt.Sprintf("layers.%d.", li)
		fields := []struct {
			name string
			dst  []float32
		}{
			{p + "ln1.weight", layer.LN1Weight}, {p + "ln1.bias", layer.LN1Bias},
			{p + "ln2.weight", layer.LN2Weight}, {p + "ln2.bias", layer.LN2Bias},
			{p + "attn.q.weight", layer.QWeight}, {p + "attn.q.bias", layer.QBias},
			{p + "attn.k.weight", layer.KWeight}, {p + "attn.k.bias", layer.KBias},
			{p + "attn.v.weight", layer.VWeight}, {p + "attn.v.bias", layer.VBias},
			{p + "attn.out.weight", layer.OWeight}, {p + "attn.out.bias", layer.OBias},
			{p + "mlp.fc1.weight", layer.FC1Weight}, {p + "mlp.fc1.bias", layer.FC1Bias},
			{p + "mlp.fc2.weight", layer.FC2Weight}, {p + "mlp.fc2.bias", layer.FC2Bias},
		}
		for _, fld := range fields {
			if err := loadF32(fld.name, fld.dst); err != nil {
				return nil, err
			}
		}
	}

	if err := loadF32("post_layernorm.weight", m.PostLNWeight); err != nil {
		return nil, err
	}
	if err := loadF32("post_layernorm.bias", m.PostLNBias); err != nil {
		return nil, err
	}

	return m, nil
}

// ─────────────────────────────────────────────────────────────────────
// Projector: safetensors + JSON sidecar (forge/multimodal/export_adapter.py)
// ─────────────────────────────────────────────────────────────────────

// safetensorsEntry is one tensor's metadata from a safetensors file's JSON
// header (https://github.com/huggingface/safetensors — "dtype","shape",
// "data_offsets":[begin,end), offsets relative to the start of the data
// section immediately following the header).
type safetensorsEntry struct {
	Dtype       string `json:"dtype"`
	Shape       []int  `json:"shape"`
	DataOffsets [2]int64
}

func (e *safetensorsEntry) UnmarshalJSON(b []byte) error {
	var raw struct {
		Dtype       string   `json:"dtype"`
		Shape       []int    `json:"shape"`
		DataOffsets [2]int64 `json:"data_offsets"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	e.Dtype, e.Shape, e.DataOffsets = raw.Dtype, raw.Shape, raw.DataOffsets
	return nil
}

// safetensorsFile is a minimal, float32-only safetensors reader — the only
// dtype forge/multimodal/export_adapter.py ever writes
// (`tensors = {...: v.contiguous().float() ...}`).
type safetensorsFile struct {
	tensors map[string]safetensorsEntry
	data    []byte // raw bytes of the data section, indexed by DataOffsets
}

func readSafetensors(path string) (*safetensorsFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("safetensors: open %s: %w", path, err)
	}
	defer f.Close()

	var hdrLen uint64
	if err := binary.Read(f, binary.LittleEndian, &hdrLen); err != nil {
		return nil, fmt.Errorf("safetensors: read header length: %w", err)
	}
	const maxHeader = 256 << 20
	if hdrLen == 0 || hdrLen > maxHeader {
		return nil, fmt.Errorf("safetensors: implausible header length %d", hdrLen)
	}
	hdrBuf := make([]byte, hdrLen)
	if _, err := io.ReadFull(f, hdrBuf); err != nil {
		return nil, fmt.Errorf("safetensors: read header: %w", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(hdrBuf, &raw); err != nil {
		return nil, fmt.Errorf("safetensors: parse header json: %w", err)
	}
	tensors := make(map[string]safetensorsEntry, len(raw))
	for name, v := range raw {
		if name == "__metadata__" {
			continue
		}
		var e safetensorsEntry
		if err := json.Unmarshal(v, &e); err != nil {
			return nil, fmt.Errorf("safetensors: parse tensor %q metadata: %w", name, err)
		}
		tensors[name] = e
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("safetensors: read data section: %w", err)
	}
	return &safetensorsFile{tensors: tensors, data: data}, nil
}

// f32 returns tensor `name`'s values as float32 plus its shape, erroring
// if the tensor is missing, not dtype F32, or its byte range is invalid.
func (s *safetensorsFile) f32(name string) ([]float32, []int, error) {
	e, ok := s.tensors[name]
	if !ok {
		return nil, nil, fmt.Errorf("safetensors: tensor %q not found", name)
	}
	if e.Dtype != "F32" {
		return nil, nil, fmt.Errorf("safetensors: tensor %q has dtype %q, want F32", name, e.Dtype)
	}
	begin, end := e.DataOffsets[0], e.DataOffsets[1]
	if begin < 0 || end < begin || end > int64(len(s.data)) {
		return nil, nil, fmt.Errorf("safetensors: tensor %q has invalid data_offsets [%d,%d) (data section is %d bytes)", name, begin, end, len(s.data))
	}
	raw := s.data[begin:end]
	if len(raw)%4 != 0 {
		return nil, nil, fmt.Errorf("safetensors: tensor %q byte length %d not a multiple of 4", name, len(raw))
	}
	n := len(raw) / 4
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out, e.Shape, nil
}

// adapterSidecarJSON is the subset of forge/multimodal/export_adapter.py's
// PREFIX.json this loader needs. Dimensions come from "tensor_shapes"
// (`{k: list(v.shape) for k,v in tensors.items()}` — always present,
// unlike "vision_adapter_config", whose VisionAdapterConfig.to_json()
// does NOT include vision_hidden, so In can't be recovered from it alone):
// "projector.0.weight" is [mlp_hidden,in] (PyTorch nn.Linear [out,in]) and
// "projector.2.weight" is [llm_hidden,mlp_hidden] — from which In/Mlp/Out
// follow directly.
type adapterSidecarJSON struct {
	TensorShapes map[string][]int `json:"tensor_shapes"`
}

// LoadSiglipProjector reads `prefix.safetensors` + `prefix.json` (written
// by forge/multimodal/export_adapter.py — either a trained stage-1
// checkpoint export, or the fixed-seed random projector at
// data/forge/eyes/projector_seed42.safetensors/.json used before a
// trained adapter exists) and returns a ready-to-use *SiglipProjector.
// The JSON sidecar's tensor_shapes supply In/Mlp/Out; every tensor's
// safetensors shape is additionally checked against those dimensions so a
// mismatched pair (e.g. a base-tower export paired with a large-tower
// adapter) fails loudly instead of silently reading garbage.
func LoadSiglipProjector(prefix string) (*SiglipProjector, error) {
	jsonPath := prefix + ".json"
	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, fmt.Errorf("siglip: read %s: %w", jsonPath, err)
	}
	var side adapterSidecarJSON
	if err := json.Unmarshal(raw, &side); err != nil {
		return nil, fmt.Errorf("siglip: parse %s: %w", jsonPath, err)
	}
	fc1JSONShape := side.TensorShapes["projector.0.weight"]
	fc2JSONShape := side.TensorShapes["projector.2.weight"]
	if len(fc1JSONShape) != 2 || len(fc2JSONShape) != 2 {
		return nil, fmt.Errorf("siglip: %s: tensor_shapes missing/malformed projector.0.weight or projector.2.weight", jsonPath)
	}
	mlp, in := fc1JSONShape[0], fc1JSONShape[1]
	out, mlp2 := fc2JSONShape[0], fc2JSONShape[1]
	if mlp != mlp2 {
		return nil, fmt.Errorf("siglip: %s: projector.0.weight mlp_hidden=%d disagrees with projector.2.weight mlp_hidden=%d", jsonPath, mlp, mlp2)
	}

	stPath := prefix + ".safetensors"
	st, err := readSafetensors(stPath)
	if err != nil {
		return nil, err
	}

	checkShape := func(name string, shape []int, want ...int) error {
		if len(shape) != len(want) {
			return fmt.Errorf("siglip: %s: tensor %q has %d dims, want %d", stPath, name, len(shape), len(want))
		}
		for i, w := range want {
			if shape[i] != w {
				return fmt.Errorf("siglip: %s: tensor %q shape %v, want %v", stPath, name, shape, want)
			}
		}
		return nil
	}

	// nn.Linear stores weight [out,in]; cortex wants [in,out] — transpose
	// on load (see forge/multimodal/export_adapter.py's doc comment).
	fc1wT, fc1Shape, err := st.f32("projector.0.weight")
	if err != nil {
		return nil, err
	}
	if err := checkShape("projector.0.weight", fc1Shape, mlp, in); err != nil {
		return nil, err
	}
	fc1b, fc1bShape, err := st.f32("projector.0.bias")
	if err != nil {
		return nil, err
	}
	if err := checkShape("projector.0.bias", fc1bShape, mlp); err != nil {
		return nil, err
	}
	fc2wT, fc2Shape, err := st.f32("projector.2.weight")
	if err != nil {
		return nil, err
	}
	if err := checkShape("projector.2.weight", fc2Shape, out, mlp); err != nil {
		return nil, err
	}
	fc2b, fc2bShape, err := st.f32("projector.2.bias")
	if err != nil {
		return nil, err
	}
	if err := checkShape("projector.2.bias", fc2bShape, out); err != nil {
		return nil, err
	}

	return &SiglipProjector{
		In: in, Mlp: mlp, Out: out,
		FC1Weight: transposeF32(fc1wT, mlp, in), // [mlp,in] -> [in,mlp]
		FC1Bias:   fc1b,
		FC2Weight: transposeF32(fc2wT, out, mlp), // [out,mlp] -> [mlp,out]
		FC2Bias:   fc2b,
	}, nil
}

// transposeF32 transposes a [rows,cols] row-major matrix into a
// [cols,rows] row-major matrix.
func transposeF32(m []float32, rows, cols int) []float32 {
	out := make([]float32, rows*cols)
	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			out[c*rows+r] = m[r*cols+c]
		}
	}
	return out
}
