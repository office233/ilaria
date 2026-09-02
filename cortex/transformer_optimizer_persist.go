package cortex

// transformer_optimizer_persist.go — Save/Load for AdamState.
//
// Adam keeps two running averages per parameter (first and second moment)
// plus a global step counter used for bias correction. If those buffers
// are discarded between training sessions, the optimizer effectively
// restarts: the very first call after a resume produces wildly biased
// updates (bias correction divides by 1 - beta^1 ≈ 0.1 for beta2=0.999)
// and the loss can spike before settling again. Persisting them keeps
// resumes truly continuous.
//
// File format mirrors transformer_persist.go: gzip-compressed JSON. The
// caller decides on the path — by convention <data-dir>/optimizer.nxto.

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// adamBlockJSON is the serialisable shape of one block's moment buffers.
type adamBlockJSON struct {
	LN1GammaM, LN1GammaV tensorJSON
	LN1BetaM, LN1BetaV   tensorJSON
	LN2GammaM, LN2GammaV tensorJSON
	LN2BetaM, LN2BetaV   tensorJSON

	WQM, WQV tensorJSON
	WKM, WKV tensorJSON
	WVM, WVV tensorJSON
	WOM, WOV tensorJSON
	BQM, BQV tensorJSON
	BKM, BKV tensorJSON
	BVM, BVV tensorJSON
	BOM, BOV tensorJSON

	W1M, W1V tensorJSON
	B1M, B1V tensorJSON
	W2M, W2V tensorJSON
	B2M, B2V tensorJSON
	// SwiGLU gate moments — empty for GELU FFNs.
	W3M, W3V tensorJSON
	B3M, B3V tensorJSON
}

// adamStateJSON is the top-level serialisable AdamState payload.
type adamStateJSON struct {
	Cfg  AdamConfig `json:"cfg"`
	Step int        `json:"step"`

	TokenEmbM tensorJSON `json:"token_emb_m"`
	TokenEmbV tensorJSON `json:"token_emb_v"`
	PosEmbM   tensorJSON `json:"pos_emb_m"`
	PosEmbV   tensorJSON `json:"pos_emb_v"`

	LNFGammaM tensorJSON `json:"lnf_gamma_m"`
	LNFGammaV tensorJSON `json:"lnf_gamma_v"`
	LNFBetaM  tensorJSON `json:"lnf_beta_m"`
	LNFBetaV  tensorJSON `json:"lnf_beta_v"`

	Blocks []adamBlockJSON `json:"blocks"`
}

// SaveAdamState writes the optimizer's moment buffers and step counter
// to path as gzip-compressed JSON. Intended to be called alongside the
// model checkpoint so resume picks up exactly where it left off.
func SaveAdamState(s *AdamState, path string) error {
	if s == nil {
		return fmt.Errorf("nil AdamState")
	}
	payload := adamStateJSON{
		Cfg:       s.Cfg,
		Step:      s.Step,
		TokenEmbM: tensorToJSON(s.TokenEmbM),
		TokenEmbV: tensorToJSON(s.TokenEmbV),
		PosEmbM:   tensorToJSON(s.PosEmbM),
		PosEmbV:   tensorToJSON(s.PosEmbV),
		LNFGammaM: tensorToJSON(s.LNFGammaM),
		LNFGammaV: tensorToJSON(s.LNFGammaV),
		LNFBetaM:  tensorToJSON(s.LNFBetaM),
		LNFBetaV:  tensorToJSON(s.LNFBetaV),
		Blocks:    make([]adamBlockJSON, len(s.Blocks)),
	}
	for i, b := range s.Blocks {
		payload.Blocks[i] = adamBlockJSON{
			LN1GammaM: tensorToJSON(b.LN1GammaM), LN1GammaV: tensorToJSON(b.LN1GammaV),
			LN1BetaM: tensorToJSON(b.LN1BetaM), LN1BetaV: tensorToJSON(b.LN1BetaV),
			LN2GammaM: tensorToJSON(b.LN2GammaM), LN2GammaV: tensorToJSON(b.LN2GammaV),
			LN2BetaM: tensorToJSON(b.LN2BetaM), LN2BetaV: tensorToJSON(b.LN2BetaV),

			WQM: tensorToJSON(b.WQM), WQV: tensorToJSON(b.WQV),
			WKM: tensorToJSON(b.WKM), WKV: tensorToJSON(b.WKV),
			WVM: tensorToJSON(b.WVM), WVV: tensorToJSON(b.WVV),
			WOM: tensorToJSON(b.WOM), WOV: tensorToJSON(b.WOV),
			BQM: tensorToJSON(b.BQM), BQV: tensorToJSON(b.BQV),
			BKM: tensorToJSON(b.BKM), BKV: tensorToJSON(b.BKV),
			BVM: tensorToJSON(b.BVM), BVV: tensorToJSON(b.BVV),
			BOM: tensorToJSON(b.BOM), BOV: tensorToJSON(b.BOV),

			W1M: tensorToJSON(b.W1M), W1V: tensorToJSON(b.W1V),
			B1M: tensorToJSON(b.B1M), B1V: tensorToJSON(b.B1V),
			W2M: tensorToJSON(b.W2M), W2V: tensorToJSON(b.W2V),
			B2M: tensorToJSON(b.B2M), B2V: tensorToJSON(b.B2V),
			W3M: tensorToJSON(b.W3M), W3V: tensorToJSON(b.W3V),
			B3M: tensorToJSON(b.B3M), B3V: tensorToJSON(b.B3V),
		}
	}

	// Write to a temp file and rename to avoid leaving a half-written
	// optimizer state if the process dies mid-write.
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(payload); err != nil {
		_ = gz.Close()
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := gz.Close(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// LoadAdamState reads back an AdamState previously written by
// SaveAdamState. Returns (nil, nil) if path does not exist, which lets
// the caller treat "no prior optimizer state" as a graceful cold start.
//
// The expected shape is derived from m, so calling this with a model
// whose architecture has changed since the dump returns a shape error
// rather than silently producing nonsense.
func LoadAdamState(m *MiniTransformer, path string) (*AdamState, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	var payload adamStateJSON
	dec := json.NewDecoder(gz)
	if err := dec.Decode(&payload); err != nil && err != io.EOF {
		return nil, err
	}

	if len(payload.Blocks) != len(m.Blocks) {
		return nil, fmt.Errorf("AdamState block count mismatch: file has %d, model has %d",
			len(payload.Blocks), len(m.Blocks))
	}

	// Build a fresh state shaped to m, then overwrite each buffer from
	// the file. Going through NewAdamState guarantees every tensor is
	// allocated with the right shape even if the file is partially
	// corrupted.
	s := NewAdamState(m, payload.Cfg)
	s.Step = payload.Step

	overwrite := func(dst *Tensor, src tensorJSON) error {
		if len(src.Data) == 0 {
			return nil // tolerate empty (e.g. older dumps with new params)
		}
		if len(src.Data) != len(dst.Data) {
			return fmt.Errorf("shape mismatch: want %d, got %d", len(dst.Data), len(src.Data))
		}
		copy(dst.Data, src.Data)
		return nil
	}

	if err := overwrite(s.TokenEmbM, payload.TokenEmbM); err != nil {
		return nil, fmt.Errorf("TokenEmbM: %w", err)
	}
	if err := overwrite(s.TokenEmbV, payload.TokenEmbV); err != nil {
		return nil, fmt.Errorf("TokenEmbV: %w", err)
	}
	if err := overwrite(s.PosEmbM, payload.PosEmbM); err != nil {
		return nil, fmt.Errorf("PosEmbM: %w", err)
	}
	if err := overwrite(s.PosEmbV, payload.PosEmbV); err != nil {
		return nil, fmt.Errorf("PosEmbV: %w", err)
	}
	if err := overwrite(s.LNFGammaM, payload.LNFGammaM); err != nil {
		return nil, fmt.Errorf("LNFGammaM: %w", err)
	}
	if err := overwrite(s.LNFGammaV, payload.LNFGammaV); err != nil {
		return nil, fmt.Errorf("LNFGammaV: %w", err)
	}
	if err := overwrite(s.LNFBetaM, payload.LNFBetaM); err != nil {
		return nil, fmt.Errorf("LNFBetaM: %w", err)
	}
	if err := overwrite(s.LNFBetaV, payload.LNFBetaV); err != nil {
		return nil, fmt.Errorf("LNFBetaV: %w", err)
	}

	type momentPair struct {
		dst *Tensor
		src tensorJSON
		tag string
	}
	for i, bp := range payload.Blocks {
		st := &s.Blocks[i]
		pairs := []momentPair{
			{st.LN1GammaM, bp.LN1GammaM, "LN1GammaM"}, {st.LN1GammaV, bp.LN1GammaV, "LN1GammaV"},
			{st.LN1BetaM, bp.LN1BetaM, "LN1BetaM"}, {st.LN1BetaV, bp.LN1BetaV, "LN1BetaV"},
			{st.LN2GammaM, bp.LN2GammaM, "LN2GammaM"}, {st.LN2GammaV, bp.LN2GammaV, "LN2GammaV"},
			{st.LN2BetaM, bp.LN2BetaM, "LN2BetaM"}, {st.LN2BetaV, bp.LN2BetaV, "LN2BetaV"},
			{st.WQM, bp.WQM, "WQM"}, {st.WQV, bp.WQV, "WQV"},
			{st.WKM, bp.WKM, "WKM"}, {st.WKV, bp.WKV, "WKV"},
			{st.WVM, bp.WVM, "WVM"}, {st.WVV, bp.WVV, "WVV"},
			{st.WOM, bp.WOM, "WOM"}, {st.WOV, bp.WOV, "WOV"},
			{st.BQM, bp.BQM, "BQM"}, {st.BQV, bp.BQV, "BQV"},
			{st.BKM, bp.BKM, "BKM"}, {st.BKV, bp.BKV, "BKV"},
			{st.BVM, bp.BVM, "BVM"}, {st.BVV, bp.BVV, "BVV"},
			{st.BOM, bp.BOM, "BOM"}, {st.BOV, bp.BOV, "BOV"},
			{st.W1M, bp.W1M, "W1M"}, {st.W1V, bp.W1V, "W1V"},
			{st.B1M, bp.B1M, "B1M"}, {st.B1V, bp.B1V, "B1V"},
			{st.W2M, bp.W2M, "W2M"}, {st.W2V, bp.W2V, "W2V"},
			{st.B2M, bp.B2M, "B2M"}, {st.B2V, bp.B2V, "B2V"},
		}
		// SwiGLU moments exist only when the model has a gate projection;
		// a mismatch between file and model on this point is an
		// architecture change and should fail loudly like any other.
		if st.W3M != nil {
			pairs = append(pairs,
				momentPair{st.W3M, bp.W3M, "W3M"},
				momentPair{st.W3V, bp.W3V, "W3V"},
				momentPair{st.B3M, bp.B3M, "B3M"},
				momentPair{st.B3V, bp.B3V, "B3V"},
			)
		}
		for _, p := range pairs {
			if err := overwrite(p.dst, p.src); err != nil {
				return nil, fmt.Errorf("block %d %s: %w", i, p.tag, err)
			}
		}
	}

	return s, nil
}
