package cortex

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

type bitLinearLoRA struct {
	Rank  int
	Scale float32
	A, B  []float32
}

// addLoRA uses the original, pre-ActQuant input, matching the Python
// LoRABitLinear contract. The ternary base is never merged or requantized.
func (l *BitLinear) addLoRA(x, y []float32) {
	a := l.lora
	if a == nil {
		return
	}
	z := make([]float32, a.Rank)
	for r := range z {
		for i, v := range x {
			z[r] += a.A[r*l.In+i] * v
		}
	}
	for o := range y {
		var delta float32
		for r, v := range z {
			delta += a.B[o*a.Rank+r] * v
		}
		y[o] += a.Scale * delta
	}
}

func bitNetProjections(l *BitNetLayer) map[string]*BitLinear {
	return map[string]*BitLinear{"q_proj": l.Q, "k_proj": l.K, "v_proj": l.V,
		"o_proj": l.O, "gate_proj": l.Gate, "up_proj": l.Up, "down_proj": l.Down}
}

// LoadBitNetLoRA loads a forge export pair (prefix.json/.safetensors).
// Call before constructing any decoder. All validation completes before
// modifying the model, so a failed load cannot partially apply an adapter.
func LoadBitNetLoRA(m *BitNetModel, prefix string) error {
	var meta struct {
		LoRA struct {
			R       int     `json:"r"`
			Alpha   float64 `json:"alpha"`
			Scaling float64 `json:"scaling"`
			N       int     `json:"n_modules"`
		} `json:"lora"`
		Base struct {
			Kind string `json:"kind"`
		} `json:"base"`
	}
	b, err := os.ReadFile(prefix + ".json")
	if err != nil {
		return err
	}
	if err = json.Unmarshal(b, &meta); err != nil {
		return err
	}
	if m == nil || meta.Base.Kind != "offline" || meta.LoRA.R < 1 || meta.LoRA.R > 4096 || meta.LoRA.N < 1 || meta.LoRA.Alpha <= 0 || math.IsInf(meta.LoRA.Alpha, 0) || math.IsNaN(meta.LoRA.Alpha) {
		return fmt.Errorf("LoRA: expected offline base and valid rank, alpha and module count")
	}
	scale := meta.LoRA.Alpha / float64(meta.LoRA.R)
	if math.Abs(scale-meta.LoRA.Scaling) > 1e-6 || math.IsInf(float64(float32(scale)), 0) {
		return fmt.Errorf("LoRA: invalid scaling")
	}
	st, err := readSafetensors(prefix + ".safetensors")
	if err != nil {
		return err
	}
	pending := make(map[*BitLinear]*bitLinearLoRA)
	for name := range st.tensors {
		if strings.HasPrefix(name, "projector.") {
			continue
		}
		parts := strings.Split(name, ".")
		if len(parts) != 5 || parts[0] != "lora" || parts[1] != "layers" || (parts[4] != "A" && parts[4] != "B") {
			return fmt.Errorf("LoRA: unexpected tensor %q", name)
		}
		idx, e := strconv.Atoi(parts[2])
		if e != nil || idx < 0 || idx >= len(m.Layers) || strconv.Itoa(idx) != parts[2] {
			return fmt.Errorf("LoRA: invalid layer %q", name)
		}
		l := bitNetProjections(m.Layers[idx])[parts[3]]
		if l == nil {
			return fmt.Errorf("LoRA: unknown projection %q", name)
		}
		if parts[4] == "B" {
			if _, ok := st.tensors[strings.TrimSuffix(name, "B")+"A"]; !ok {
				return fmt.Errorf("LoRA: unpaired tensor %q", name)
			}
			continue
		}
		a, shape, e := st.f32(name)
		if e != nil {
			return e
		}
		if len(shape) != 2 || shape[0] != meta.LoRA.R || shape[1] != l.In || len(a) != meta.LoRA.R*l.In {
			return fmt.Errorf("LoRA: invalid A shape for %s", name)
		}
		bb, shape, e := st.f32(strings.TrimSuffix(name, "A") + "B")
		if e != nil {
			return e
		}
		if len(shape) != 2 || shape[0] != l.Out || shape[1] != meta.LoRA.R || len(bb) != l.Out*meta.LoRA.R {
			return fmt.Errorf("LoRA: invalid B shape for %s", name)
		}
		for _, values := range [][]float32{a, bb} {
			for _, v := range values {
				if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
					return fmt.Errorf("LoRA: nonfinite weights in %s", name)
				}
			}
		}
		pending[l] = &bitLinearLoRA{Rank: meta.LoRA.R, Scale: float32(scale), A: a, B: bb}
	}
	if len(pending) != meta.LoRA.N {
		return fmt.Errorf("LoRA: got %d modules, expected %d", len(pending), meta.LoRA.N)
	}
	for _, layer := range m.Layers {
		for _, l := range bitNetProjections(layer) {
			l.lora = pending[l]
		}
	}
	return nil
}
