package cortex

// audio_whisper_persist.go — loaders for the two files
// cortex/audio_whisper.go's tower/projector are built from:
//
//   - LoadWhisperEncoderTower reads the NXTF v3 file
//     forge/multimodal/export_whisper_tower.py writes (magic "NXTF3BIN",
//     arch "whisper_encoder") — same container format bitnet_persist.go's
//     LoadBitNetModel and vision_siglip_persist.go's
//     LoadSiglipVisionTower read (same nxtf3Magic, same
//     magic+hdrLen+JSON-header+blobs layout — see either file's doc
//     comment), just a different tensor set: every tensor here is kind
//     "f32" (no ternary weights), same as the vision tower.
//
//   - LoadAudioProjector reads the safetensors + JSON sidecar pair
//     forge/multimodal/export_audio_adapter.py writes (PREFIX.safetensors +
//     PREFIX.json) — the SAME format export_adapter.py (vision) writes,
//     down to the "tensor_shapes" JSON field name and "projector.0.*"/
//     "projector.2.*" tensor names, just with the vision-specific
//     "vision_adapter_config" field replaced by "audio_adapter_config"
//     (which this loader doesn't need — the tensor shapes alone are
//     enough to reconstruct In/Mlp/Out, exactly as
//     vision_siglip_persist.go's LoadSiglipProjector doc comment notes).
//     Reuses vision_siglip_persist.go's safetensors reader
//     (readSafetensors/safetensorsFile.f32/transposeF32) and its
//     adapterSidecarJSON type verbatim — per the task's own instruction to
//     check for an existing reader before writing a new one; there is
//     nothing audio-specific about either, so no duplicate is created.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

// ─────────────────────────────────────────────────────────────────────
// Tower: NXTF v3, arch "whisper_encoder"
// ─────────────────────────────────────────────────────────────────────

// whisperConfigJSON mirrors WhisperEncoderConfig's fields with the
// snake_case JSON tags forge/multimodal/export_whisper_tower.py's NXTF
// header uses (same shadow-struct pattern as bitnet_persist.go's
// bitnetConfigJSON / vision_siglip_persist.go's siglipConfigJSON).
type whisperConfigJSON struct {
	NumMelBins         int     `json:"num_mel_bins"`
	Hidden             int     `json:"hidden_size"`
	NumLayers          int     `json:"num_layers"`
	NumHeads           int     `json:"num_heads"`
	Intermediate       int     `json:"intermediate_size"`
	MaxSourcePositions int     `json:"max_source_positions"`
	NFFT               int     `json:"n_fft"`
	HopLength          int     `json:"hop_length"`
	ChunkLength        int     `json:"chunk_length"`
	SamplingRate       int     `json:"sampling_rate"`
	NumFreqBins        int     `json:"num_freq_bins"`
	LayerNormEps       float64 `json:"layer_norm_eps"`
	HiddenAct          string  `json:"hidden_act"`
}

func (c whisperConfigJSON) toWhisperEncoderConfig() WhisperEncoderConfig {
	return WhisperEncoderConfig{
		NumMelBins:         c.NumMelBins,
		Hidden:             c.Hidden,
		NumLayers:          c.NumLayers,
		NumHeads:           c.NumHeads,
		Intermediate:       c.Intermediate,
		MaxSourcePositions: c.MaxSourcePositions,
		NFFT:               c.NFFT,
		HopLength:          c.HopLength,
		ChunkLength:        c.ChunkLength,
		SamplingRate:       c.SamplingRate,
		NumFreqBins:        c.NumFreqBins,
		LayerNormEps:       c.LayerNormEps,
		HiddenAct:          c.HiddenAct,
	}
}

// whisperTensorJSON is one entry of the NXTF v3 header's "tensors" list —
// structurally identical to bitnetTensorJSON/siglipTensorJSON (the NXTF
// container format is architecture-agnostic — see nxtf3.py's doc
// comment); kept as its own type rather than reused across files, matching
// this package's existing per-arch-file convention (bitnet_persist.go and
// vision_siglip_persist.go each have their own copy too).
type whisperTensorJSON struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"` // always "f32" for this arch
	Shape  []int  `json:"shape"`
	Offset int64  `json:"offset"`
	Bytes  int64  `json:"bytes"`
}

type whisperHeaderJSON struct {
	Version int                 `json:"version"`
	Arch    string              `json:"arch"`
	Config  whisperConfigJSON   `json:"config"`
	Tensors []whisperTensorJSON `json:"tensors"`
}

// LoadWhisperEncoderTower reads an NXTF v3 file written by
// forge/multimodal/export_whisper_tower.py (arch "whisper_encoder", either
// the real openai/whisper-small export or the --tiny synthetic fixture)
// and returns a fully-populated *WhisperEncoderTower. Every tensor the
// header lists must be present and exactly the size
// NewWhisperEncoderTower(header.Config) expects; any mismatch is reported
// as an error, never a silent partial load — same contract as
// bitnet_persist.go's LoadBitNetModel and vision_siglip_persist.go's
// LoadSiglipVisionTower.
func LoadWhisperEncoderTower(path string) (*WhisperEncoderTower, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("whisper: open %s: %w", path, err)
	}
	defer f.Close()

	var magic [8]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return nil, fmt.Errorf("whisper: read magic: %w", err)
	}
	if magic != nxtf3Magic {
		return nil, fmt.Errorf("whisper: bad magic %q, want %q", magic, nxtf3Magic)
	}

	var hdrLen uint32
	if err := binary.Read(f, binary.LittleEndian, &hdrLen); err != nil {
		return nil, fmt.Errorf("whisper: read header length: %w", err)
	}
	const maxHeader = 256 << 20
	if hdrLen == 0 || hdrLen > maxHeader {
		return nil, fmt.Errorf("whisper: implausible header length %d", hdrLen)
	}
	hdrBuf := make([]byte, hdrLen)
	if _, err := io.ReadFull(f, hdrBuf); err != nil {
		return nil, fmt.Errorf("whisper: read header: %w", err)
	}

	var hdr whisperHeaderJSON
	if err := json.Unmarshal(hdrBuf, &hdr); err != nil {
		return nil, fmt.Errorf("whisper: parse header json: %w", err)
	}
	if hdr.Version != 3 {
		return nil, fmt.Errorf("whisper: unsupported NXTF version %d, want 3", hdr.Version)
	}
	if hdr.Arch != "whisper_encoder" {
		return nil, fmt.Errorf("whisper: unsupported arch %q, want %q", hdr.Arch, "whisper_encoder")
	}
	if hdr.Config.HiddenAct != "gelu" {
		return nil, fmt.Errorf("whisper: unsupported hidden_act %q, want %q", hdr.Config.HiddenAct, "gelu")
	}

	cfg := hdr.Config.toWhisperEncoderConfig()
	m := NewWhisperEncoderTower(cfg)

	dataStart := int64(len(magic)) + 4 + int64(hdrLen)
	byName := make(map[string]whisperTensorJSON, len(hdr.Tensors))
	for _, t := range hdr.Tensors {
		byName[t.Name] = t
	}

	loadF32 := func(name string, dst []float32) error {
		t, ok := byName[name]
		if !ok {
			return fmt.Errorf("whisper: tensor %q missing from NXTF header", name)
		}
		if t.Kind != "f32" {
			return fmt.Errorf("whisper: tensor %q has kind %q, want f32", name, t.Kind)
		}
		buf := make([]byte, t.Bytes)
		if _, err := f.ReadAt(buf, dataStart+t.Offset); err != nil {
			return fmt.Errorf("whisper: read tensor %q (%d bytes at +%d): %w", name, t.Bytes, t.Offset, err)
		}
		if len(buf)%4 != 0 {
			return fmt.Errorf("whisper: tensor %q byte length %d not a multiple of 4", name, len(buf))
		}
		n := len(buf) / 4
		if n != len(dst) {
			return fmt.Errorf("whisper: tensor %q has %d float32 values, want %d", name, n, len(dst))
		}
		for i := 0; i < n; i++ {
			dst[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		return nil
	}

	if err := loadF32("conv1.weight", m.Conv1Weight); err != nil {
		return nil, err
	}
	if err := loadF32("conv1.bias", m.Conv1Bias); err != nil {
		return nil, err
	}
	if err := loadF32("conv2.weight", m.Conv2Weight); err != nil {
		return nil, err
	}
	if err := loadF32("conv2.bias", m.Conv2Bias); err != nil {
		return nil, err
	}
	if err := loadF32("embed_positions.weight", m.EmbedPositions); err != nil {
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

	if err := loadF32("final_layernorm.weight", m.FinalLNWeight); err != nil {
		return nil, err
	}
	if err := loadF32("final_layernorm.bias", m.FinalLNBias); err != nil {
		return nil, err
	}
	if err := loadF32("mel_filters.weight", m.MelFilters); err != nil {
		return nil, err
	}

	return m, nil
}

// ─────────────────────────────────────────────────────────────────────
// Projector: safetensors + JSON sidecar (forge/multimodal/export_audio_adapter.py)
// ─────────────────────────────────────────────────────────────────────

// LoadAudioProjector reads `prefix.safetensors` + `prefix.json` (written
// by forge/multimodal/export_audio_adapter.py — either a trained stage-1
// audio checkpoint export, or a random-weights fixture round-tripped
// through the same export code path for testing, before a trained
// projector exists) and returns a ready-to-use *AudioProjector. The JSON
// sidecar's "tensor_shapes" supplies In/Mlp/Out — same schema
// export_adapter.py (vision) writes, see
// vision_siglip_persist.go's adapterSidecarJSON, reused here verbatim.
// Every tensor's safetensors shape is additionally checked against those
// dimensions so a mismatched pair fails loudly instead of silently
// reading garbage — same contract as LoadSiglipProjector.
func LoadAudioProjector(prefix string) (*AudioProjector, error) {
	jsonPath := prefix + ".json"
	raw, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, fmt.Errorf("whisper: read %s: %w", jsonPath, err)
	}
	var side adapterSidecarJSON
	if err := json.Unmarshal(raw, &side); err != nil {
		return nil, fmt.Errorf("whisper: parse %s: %w", jsonPath, err)
	}
	fc1JSONShape := side.TensorShapes["projector.0.weight"]
	fc2JSONShape := side.TensorShapes["projector.2.weight"]
	if len(fc1JSONShape) != 2 || len(fc2JSONShape) != 2 {
		return nil, fmt.Errorf("whisper: %s: tensor_shapes missing/malformed projector.0.weight or projector.2.weight", jsonPath)
	}
	mlp, in := fc1JSONShape[0], fc1JSONShape[1]
	out, mlp2 := fc2JSONShape[0], fc2JSONShape[1]
	if mlp != mlp2 {
		return nil, fmt.Errorf("whisper: %s: projector.0.weight mlp_hidden=%d disagrees with projector.2.weight mlp_hidden=%d", jsonPath, mlp, mlp2)
	}

	stPath := prefix + ".safetensors"
	st, err := readSafetensors(stPath)
	if err != nil {
		return nil, err
	}

	checkShape := func(name string, shape []int, want ...int) error {
		if len(shape) != len(want) {
			return fmt.Errorf("whisper: %s: tensor %q has %d dims, want %d", stPath, name, len(shape), len(want))
		}
		for i, w := range want {
			if shape[i] != w {
				return fmt.Errorf("whisper: %s: tensor %q shape %v, want %v", stPath, name, shape, want)
			}
		}
		return nil
	}

	// nn.Linear stores weight [out,in]; cortex wants [in,out] — transpose
	// on load (see forge/multimodal/export_audio_adapter.py's doc
	// comment).
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

	return &AudioProjector{
		In: in, Mlp: mlp, Out: out,
		FC1Weight: transposeF32(fc1wT, mlp, in), // [mlp,in] -> [in,mlp]
		FC1Bias:   fc1b,
		FC2Weight: transposeF32(fc2wT, out, mlp), // [out,mlp] -> [mlp,out]
		FC2Bias:   fc2b,
	}, nil
}
