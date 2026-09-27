package cortex

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func tinyLoRAModel() *BitNetModel {
	m := NewBitNetModel(BitNetConfig{VocabSize: 32, EmbedDim: 16, NumLayers: 1, NumHeads: 2, NumKVHeads: 1, FFNDim: 32, MaxSeqLen: 64, RopeTheta: 10000, RMSNormEps: 1e-5})
	for i := range m.Embed {
		m.Embed[i] = float32(math.Sin(float64(i)*0.7)) * 0.1
	}
	for _, layer := range m.Layers {
		for _, l := range bitNetProjections(layer) {
			for o := 0; o < l.Out; o++ {
				row := make([]int8, l.In)
				for i := range row {
					row[i] = int8((o+i)%3) - 1
				}
				l.SetRow(o, row)
			}
			l.Scale = 0.03
		}
	}
	return m
}

func writeLoRAFixture(t *testing.T, m *BitNetModel) string {
	t.Helper()
	prefix := filepath.Join(t.TempDir(), "adapter")
	head := map[string]any{}
	var payload []byte
	for name, l := range bitNetProjections(m.Layers[0]) {
		for _, key := range []string{"A", "B"} {
			shape := []int{2, l.In}
			if key == "B" {
				shape = []int{l.Out, 2}
			}
			start := len(payload)
			for i := 0; i < shape[0]*shape[1]; i++ {
				var b [4]byte
				binary.LittleEndian.PutUint32(b[:], math.Float32bits(float32(math.Cos(float64(i)))*0.02))
				payload = append(payload, b[:]...)
			}
			head["lora.layers.0."+name+"."+key] = map[string]any{"dtype": "F32", "shape": shape, "data_offsets": []int{start, len(payload)}}
		}
	}
	h, _ := json.Marshal(head)
	out := make([]byte, 8)
	binary.LittleEndian.PutUint64(out, uint64(len(h)))
	out = append(out, h...)
	out = append(out, payload...)
	if err := os.WriteFile(prefix+".safetensors", out, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prefix+".json", []byte(`{"base":{"kind":"offline"},"lora":{"r":2,"alpha":4,"scaling":2,"n_modules":7}}`), 0600); err != nil {
		t.Fatal(err)
	}
	return prefix
}

func TestBitLinearLoRAUsesRawInput(t *testing.T) {
	l := NewBitLinear(2, 2)
	l.lora = &bitLinearLoRA{Rank: 1, Scale: 2, A: []float32{1, 2}, B: []float32{3, 4}}
	x := []float32{0.001, 1}
	want := []float32{6 * 2.001, 8 * 2.001}
	for _, got := range [][]float32{l.Forward(x), l.ForwardBatch([][]float32{x})[0]} {
		for i, v := range got {
			if math.Abs(float64(v-want[i])) > 1e-5 {
				t.Fatalf("got %v want %v", got, want)
			}
		}
	}
}

func TestBitNetLoRAExportAndCachedDecode(t *testing.T) {
	m := tinyLoRAModel()
	prefix := writeLoRAFixture(t, m)
	before := m.Forward([]int{1, 2, 3})
	if err := LoadBitNetLoRA(m, prefix); err != nil {
		t.Fatal(err)
	}
	want := m.Forward([]int{1, 2, 3})
	d := NewBitNetDecoder(m)
	d.Prefill([]int{1, 2})
	got := d.Step(3)
	changed := false
	for i, v := range got {
		if math.Abs(float64(v-want[2][i])) > 1e-5 {
			t.Fatalf("cached logits differ at %d", i)
		}
		if math.Abs(float64(v-before[2][i])) > 1e-6 {
			changed = true
		}
	}
	if !changed {
		t.Fatal("adapter did not affect logits")
	}
	old := m.Layers[0].Q.lora
	if err := os.WriteFile(prefix+".json", []byte(`{"base":{"kind":"bf16"},"lora":{"r":2,"alpha":4,"scaling":2,"n_modules":7}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if LoadBitNetLoRA(m, prefix) == nil {
		t.Fatal("accepted incompatible base")
	}
	if old != m.Layers[0].Q.lora {
		t.Fatal("failed load modified adapter")
	}
}
