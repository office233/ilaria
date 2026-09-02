package main

// gpt2-import — load pretrained GPT-2-family weights into a Nexus
// MiniTransformer checkpoint, skipping local pre-training entirely.
//
// WHY THIS IS POSSIBLE
//
// MiniTransformer is architecturally a GPT-2: pre-norm decoder blocks,
// learned absolute positions, tanh-approx GELU, LayerNorm(γ,β) with
// eps 1e-5, tied LM head, and row-vector matmul with [in,out] weight
// layout — which is exactly how GPT-2's Conv1D stores its matrices, so
// every weight copies over WITHOUT transposition. The only split needed
// is c_attn [d,3d] → WQ|WK|WV columns.
//
// USAGE
//
//	go run ./cmd/gpt2-import -src <dir> -out ./data/cortex-gpt2
//
// where <dir> contains, downloaded from the model's Hugging Face repo
// ("gpt2", "distilgpt2", "gpt2-medium"):
//
//	model.safetensors   (weights; fp32/fp16/bf16 all accepted)
//	vocab.json          (byte-level vocabulary)
//	merges.txt          (BPE merge ranks)
//	config.json         (n_layer/n_head/n_embd/n_ctx)
//
// Output: transformer.nxtf (binary v2) + tokenizer.json in -out, ready
// for cortex-web / broca-eval / the cognitive bridge.

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"time"

	cortex "nexus-cortex/cortex"
)

// ─────────────────────────────────────────────────────────────────────
// safetensors reader
// ─────────────────────────────────────────────────────────────────────

// stEntry describes one tensor inside a .safetensors file: dtype,
// shape, and the [begin,end) byte span within the data region.
type stEntry struct {
	Dtype   string   `json:"dtype"`
	Shape   []int    `json:"shape"`
	Offsets [2]int64 `json:"data_offsets"`
}

// safetensorsFile holds the parsed header plus the raw data region.
type safetensorsFile struct {
	entries map[string]stEntry
	data    []byte
}

// openSafetensors reads and validates a .safetensors file whole; at
// GPT-2 scale (≤700 MB) that is well within the machine's RAM and far
// simpler than windowed reads.
func openSafetensors(path string) (*safetensorsFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) < 8 {
		return nil, fmt.Errorf("file too short for safetensors header")
	}
	hdrLen := binary.LittleEndian.Uint64(raw)
	if hdrLen > uint64(len(raw)-8) {
		return nil, fmt.Errorf("corrupt header length %d", hdrLen)
	}
	var header map[string]json.RawMessage
	if err := json.Unmarshal(raw[8:8+hdrLen], &header); err != nil {
		return nil, fmt.Errorf("parse header: %w", err)
	}
	entries := make(map[string]stEntry, len(header))
	for name, msg := range header {
		if name == "__metadata__" {
			continue
		}
		var e stEntry
		if err := json.Unmarshal(msg, &e); err != nil {
			return nil, fmt.Errorf("entry %s: %w", name, err)
		}
		entries[name] = e
	}
	return &safetensorsFile{entries: entries, data: raw[8+hdrLen:]}, nil
}

// tensor fetches a named tensor as float32, converting from fp16/bf16
// when needed. GPT-2's official files are fp32, but community mirrors
// often re-export in half precision.
func (sf *safetensorsFile) tensor(name string) ([]float32, []int, error) {
	e, ok := sf.entries[name]
	if !ok {
		// HF exports the same weights with or without the module prefix
		// depending on which wrapper class saved them.
		if e, ok = sf.entries["transformer."+name]; !ok {
			return nil, nil, fmt.Errorf("tensor %q not found", name)
		}
	}
	begin, end := int(e.Offsets[0]), int(e.Offsets[1])
	if begin < 0 || end > len(sf.data) || begin > end {
		return nil, nil, fmt.Errorf("tensor %q offsets out of range", name)
	}
	raw := sf.data[begin:end]

	n := 1
	for _, d := range e.Shape {
		n *= d
	}
	out := make([]float32, n)

	switch e.Dtype {
	case "F32":
		if len(raw) != n*4 {
			return nil, nil, fmt.Errorf("tensor %q: size mismatch", name)
		}
		for i := 0; i < n; i++ {
			out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
		}
	case "F16":
		if len(raw) != n*2 {
			return nil, nil, fmt.Errorf("tensor %q: size mismatch", name)
		}
		for i := 0; i < n; i++ {
			out[i] = f16ToF32(binary.LittleEndian.Uint16(raw[i*2:]))
		}
	case "BF16":
		if len(raw) != n*2 {
			return nil, nil, fmt.Errorf("tensor %q: size mismatch", name)
		}
		for i := 0; i < n; i++ {
			out[i] = math.Float32frombits(uint32(binary.LittleEndian.Uint16(raw[i*2:])) << 16)
		}
	default:
		return nil, nil, fmt.Errorf("tensor %q: unsupported dtype %s", name, e.Dtype)
	}
	return out, e.Shape, nil
}

// f16ToF32 expands IEEE 754 half precision.
func f16ToF32(h uint16) float32 {
	sign := uint32(h>>15) << 31
	exp := uint32(h>>10) & 0x1F
	frac := uint32(h) & 0x3FF
	switch exp {
	case 0:
		if frac == 0 {
			return math.Float32frombits(sign)
		}
		// subnormal: renormalise
		e := uint32(127 - 15 + 1)
		for frac&0x400 == 0 {
			frac <<= 1
			e--
		}
		frac &= 0x3FF
		return math.Float32frombits(sign | e<<23 | frac<<13)
	case 0x1F:
		return math.Float32frombits(sign | 0xFF<<23 | frac<<13)
	default:
		return math.Float32frombits(sign | (exp+127-15)<<23 | frac<<13)
	}
}

// ─────────────────────────────────────────────────────────────────────
// GPT-2 → MiniTransformer mapping
// ─────────────────────────────────────────────────────────────────────

// hfConfig is the subset of Hugging Face config.json the import needs.
type hfConfig struct {
	NLayer int `json:"n_layer"`
	NHead  int `json:"n_head"`
	NEmbd  int `json:"n_embd"`
	NCtx   int `json:"n_positions"`
}

// fill copies src into dst.Data after an exact shape check — a silent
// shape mismatch here would produce a model that runs but babbles.
func fill(dst *cortex.Tensor, src []float32, shape []int) error {
	if len(shape) != len(dst.Shape) {
		return fmt.Errorf("rank %d, want %d", len(shape), len(dst.Shape))
	}
	for i := range shape {
		if shape[i] != dst.Shape[i] {
			return fmt.Errorf("dim %d is %d, want %d", i, shape[i], dst.Shape[i])
		}
	}
	copy(dst.Data, src)
	return nil
}

// buildModel wires every GPT-2 tensor into a fresh MiniTransformer.
func buildModel(sf *safetensorsFile, hc hfConfig, eosID int) (*cortex.MiniTransformer, error) {
	cfg := cortex.TransformerConfig{
		VocabSize:  0, // set from wte below
		EmbedDim:   hc.NEmbd,
		NumHeads:   hc.NHead,
		NumLayers:  hc.NLayer,
		FFNDim:     4 * hc.NEmbd,
		MaxSeqLen:  hc.NCtx,
		EOSTokenID: eosID,
	}

	wte, wteShape, err := sf.tensor("wte.weight")
	if err != nil {
		return nil, err
	}
	cfg.VocabSize = wteShape[0]

	m := cortex.NewMiniTransformer(cfg, rand.New(rand.NewSource(42)))
	m.UseTiedWeights = true

	if err := fill(m.Embedding.TokenEmb, wte, wteShape); err != nil {
		return nil, fmt.Errorf("wte: %w", err)
	}
	wpe, wpeShape, err := sf.tensor("wpe.weight")
	if err != nil {
		return nil, err
	}
	if err := fill(m.Embedding.PosEmb, wpe, wpeShape); err != nil {
		return nil, fmt.Errorf("wpe: %w", err)
	}

	d := hc.NEmbd
	for l := 0; l < hc.NLayer; l++ {
		b := m.Blocks[l]
		p := fmt.Sprintf("h.%d.", l)

		load := func(name string, dst *cortex.Tensor) error {
			data, shape, err := sf.tensor(p + name)
			if err != nil {
				return err
			}
			if err := fill(dst, data, shape); err != nil {
				return fmt.Errorf("%s%s: %w", p, name, err)
			}
			return nil
		}

		if err := load("ln_1.weight", b.LN1Gamma); err != nil {
			return nil, err
		}
		if err := load("ln_1.bias", b.LN1Beta); err != nil {
			return nil, err
		}
		if err := load("ln_2.weight", b.LN2Gamma); err != nil {
			return nil, err
		}
		if err := load("ln_2.bias", b.LN2Beta); err != nil {
			return nil, err
		}

		// c_attn packs Q|K|V column-wise: weight [d, 3d], bias [3d].
		// Row i of the weight holds (q_row | k_row | v_row), so the
		// split is a per-row slice copy — no transposition anywhere.
		aw, awShape, err := sf.tensor(p + "attn.c_attn.weight")
		if err != nil {
			return nil, err
		}
		if awShape[0] != d || awShape[1] != 3*d {
			return nil, fmt.Errorf("%sattn.c_attn.weight: shape %v, want [%d %d]", p, awShape, d, 3*d)
		}
		for i := 0; i < d; i++ {
			row := aw[i*3*d:]
			copy(b.Attn.WQ.Data[i*d:(i+1)*d], row[0:d])
			copy(b.Attn.WK.Data[i*d:(i+1)*d], row[d:2*d])
			copy(b.Attn.WV.Data[i*d:(i+1)*d], row[2*d:3*d])
		}
		ab, abShape, err := sf.tensor(p + "attn.c_attn.bias")
		if err != nil {
			return nil, err
		}
		if abShape[0] != 3*d {
			return nil, fmt.Errorf("%sattn.c_attn.bias: shape %v, want [%d]", p, abShape, 3*d)
		}
		copy(b.Attn.BQ.Data, ab[0:d])
		copy(b.Attn.BK.Data, ab[d:2*d])
		copy(b.Attn.BV.Data, ab[2*d:3*d])

		if err := load("attn.c_proj.weight", b.Attn.WO); err != nil {
			return nil, err
		}
		if err := load("attn.c_proj.bias", b.Attn.BO); err != nil {
			return nil, err
		}
		if err := load("mlp.c_fc.weight", b.FFN.W1); err != nil {
			return nil, err
		}
		if err := load("mlp.c_fc.bias", b.FFN.B1); err != nil {
			return nil, err
		}
		if err := load("mlp.c_proj.weight", b.FFN.W2); err != nil {
			return nil, err
		}
		if err := load("mlp.c_proj.bias", b.FFN.B2); err != nil {
			return nil, err
		}
	}

	lnfW, lnfWS, err := sf.tensor("ln_f.weight")
	if err != nil {
		return nil, err
	}
	if err := fill(m.LNFGamma, lnfW, lnfWS); err != nil {
		return nil, fmt.Errorf("ln_f.weight: %w", err)
	}
	lnfB, lnfBS, err := sf.tensor("ln_f.bias")
	if err != nil {
		return nil, err
	}
	if err := fill(m.LNFBeta, lnfB, lnfBS); err != nil {
		return nil, fmt.Errorf("ln_f.bias: %w", err)
	}

	return m, nil
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

func main() {
	src := flag.String("src", "", "Directory with model.safetensors, vocab.json, merges.txt, config.json (required)")
	out := flag.String("out", "./data/cortex-gpt2", "Output data directory")
	probe := flag.String("probe", "The capital of France is", "Prompt for the post-import sanity generation")
	probeTokens := flag.Int("probe-tokens", 12, "Tokens to generate in the sanity check (0 = skip)")
	flag.Parse()

	if *src == "" {
		fmt.Fprintln(os.Stderr, "error: -src is required")
		flag.Usage()
		os.Exit(1)
	}

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}

	// Tokenizer first — cheap, and its EOS id parameterises the model.
	tok, err := cortex.LoadGPT2Tokenizer(
		filepath.Join(*src, "vocab.json"),
		filepath.Join(*src, "merges.txt"),
	)
	if err != nil {
		fail("tokenizer", err)
	}
	fmt.Printf("[import] tokenizer: %d tokens, %d merges, byte-level\n",
		tok.ActualVocabSize(), len(tok.Merges))

	cfgRaw, err := os.ReadFile(filepath.Join(*src, "config.json"))
	if err != nil {
		fail("config.json", err)
	}
	var hc hfConfig
	if err := json.Unmarshal(cfgRaw, &hc); err != nil {
		fail("config.json", err)
	}
	if hc.NLayer <= 0 || hc.NHead <= 0 || hc.NEmbd <= 0 || hc.NCtx <= 0 {
		fail("config.json", fmt.Errorf("missing n_layer/n_head/n_embd/n_positions: %+v", hc))
	}
	fmt.Printf("[import] config: %d layers, %d heads, d=%d, ctx=%d\n",
		hc.NLayer, hc.NHead, hc.NEmbd, hc.NCtx)

	start := time.Now()
	sf, err := openSafetensors(filepath.Join(*src, "model.safetensors"))
	if err != nil {
		fail("safetensors", err)
	}
	names := make([]string, 0, len(sf.entries))
	for n := range sf.entries {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Printf("[import] safetensors: %d tensors\n", len(names))

	model, err := buildModel(sf, hc, tok.EosID())
	if err != nil {
		fail("weight mapping", err)
	}
	fmt.Printf("[import] model built: %.1fM params in %.1fs\n",
		float64(model.ParamCount())/1e6, time.Since(start).Seconds())

	// Sanity generation BEFORE saving: a mapping mistake shows up here
	// as gibberish, and catching it now beats debugging a bad checkpoint.
	if *probeTokens > 0 {
		ids := tok.Encode(*probe)
		genStart := time.Now()
		outIDs := model.GenerateFast(ids, *probeTokens, 0.7, 40)
		fmt.Printf("[import] probe (%.2fs/token): %q → %q\n",
			time.Since(genStart).Seconds()/float64(*probeTokens),
			*probe, tok.Decode(outIDs))
	}

	if err := os.MkdirAll(*out, 0700); err != nil {
		fail("mkdir", err)
	}
	tfPath := filepath.Join(*out, "transformer.nxtf")
	if err := model.SaveBinary(tfPath); err != nil {
		fail("save transformer", err)
	}
	tokPath := filepath.Join(*out, "tokenizer.json")
	if err := tok.Save(tokPath); err != nil {
		fail("save tokenizer", err)
	}

	// Reload everything from disk and generate once more: proves the
	// checkpoint a downstream process will read, not just the in-memory
	// model. A silent save/load defect would otherwise surface days
	// later as mysterious gibberish.
	reTok, err := cortex.LoadBPETokenizer(tokPath)
	if err != nil {
		fail("reload tokenizer", err)
	}
	reModel, err := cortex.LoadMiniTransformer(tfPath, rand.New(rand.NewSource(42)))
	if err != nil {
		fail("reload transformer", err)
	}
	if reModel == nil {
		fail("reload transformer", fmt.Errorf("checkpoint not found after save"))
	}
	if *probeTokens > 0 {
		ids := reTok.Encode(*probe)
		outIDs := reModel.GenerateFast(ids, *probeTokens, 0.7, 40)
		fmt.Printf("[import] reload check: %q → %q\n", *probe, reTok.Decode(outIDs))
	}

	fmt.Printf("[import] DONE: %s + %s\n", tfPath, tokPath)
	fmt.Println("[import] use with e.g.: go run ./cmd/cortex-web -data-dir", *out)
}
