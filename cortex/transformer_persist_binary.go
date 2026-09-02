package cortex

// transformer_persist_binary.go — binary checkpoint format (v2) for
// MiniTransformer.
//
// WHY: the v1 format streams every float through encoding/json inside
// gzip. At 5M params that is tolerable; at GPT-2 scale (124M params ≈
// 500 MB of float32) JSON costs minutes of CPU and gigabytes of
// intermediate text. The binary format is a plain dump: read/write at
// disk speed, byte-exact roundtrip, ~4 bytes/param on disk.
//
// Layout (all little-endian):
//
//	magic   [8]byte  "NXTF2BIN"
//	hdrLen  uint32   length of the JSON header that follows
//	header  []byte   JSON: {version, config, use_tied_weights}
//	tensors ...      fixed order, each:
//	                   ndim uint32, dims [ndim]uint32, data [n]float32
//
// Tensor order: TokenEmb, PosEmb, then per block (WQ WK WV WO BQ BK BV
// BO W1 B1 W2 B2 LN1Gamma LN1Beta LN2Gamma LN2Beta), then LNFGamma,
// LNFBeta. The order is defined by weightTensors(), shared between save
// and load so it cannot drift.
//
// LoadMiniTransformer sniffs the magic and dispatches, so callers keep
// using one entry point for both formats.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
)

var nxtf2Magic = [8]byte{'N', 'X', 'T', 'F', '2', 'B', 'I', 'N'}

// binaryHeader is the small JSON blob after the magic.
type binaryHeader struct {
	Version int               `json:"version"`
	Config  TransformerConfig `json:"config"`
	UseTied bool              `json:"use_tied_weights"`
}

// weightTensors returns every persisted tensor of m in canonical order.
// Save writes them in this order; load reads into the same slice, so a
// single definition guards both directions.
func (m *MiniTransformer) weightTensors() []*Tensor {
	ts := []*Tensor{m.Embedding.TokenEmb, m.Embedding.PosEmb}
	for _, b := range m.Blocks {
		ts = append(ts,
			b.Attn.WQ, b.Attn.WK, b.Attn.WV, b.Attn.WO,
			b.Attn.BQ, b.Attn.BK, b.Attn.BV, b.Attn.BO,
			b.FFN.W1, b.FFN.B1, b.FFN.W2, b.FFN.B2,
			b.LN1Gamma, b.LN1Beta, b.LN2Gamma, b.LN2Beta,
		)
		// SwiGLU gate — presence is decided by Config.UseSwiGLU, which
		// travels in the header, so save and load agree on the layout.
		if b.FFN.W3 != nil {
			ts = append(ts, b.FFN.W3, b.FFN.B3)
		}
	}
	return append(ts, m.LNFGamma, m.LNFBeta)
}

// writeTensorBinary streams one tensor: dims then raw float32 data.
// Floats are converted in chunks to avoid reflection (encoding/binary
// on a large []float32 is an order of magnitude slower).
func writeTensorBinary(w *bufio.Writer, t *Tensor) error {
	if err := binary.Write(w, binary.LittleEndian, uint32(len(t.Shape))); err != nil {
		return err
	}
	for _, d := range t.Shape {
		if err := binary.Write(w, binary.LittleEndian, uint32(d)); err != nil {
			return err
		}
	}
	var buf [4096]byte
	for off := 0; off < len(t.Data); {
		n := len(t.Data) - off
		if n > len(buf)/4 {
			n = len(buf) / 4
		}
		for i := 0; i < n; i++ {
			binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(t.Data[off+i]))
		}
		if _, err := w.Write(buf[:n*4]); err != nil {
			return err
		}
		off += n
	}
	return nil
}

// readTensorBinary reads one tensor written by writeTensorBinary into
// dst, enforcing an exact shape match — a mismatch means the file and
// the config disagree and continuing would scramble weights silently.
func readTensorBinary(r *bufio.Reader, dst *Tensor) error {
	var ndim uint32
	if err := binary.Read(r, binary.LittleEndian, &ndim); err != nil {
		return err
	}
	if int(ndim) != len(dst.Shape) {
		return fmt.Errorf("tensor ndim %d, want %d", ndim, len(dst.Shape))
	}
	total := 1
	for i := 0; i < int(ndim); i++ {
		var d uint32
		if err := binary.Read(r, binary.LittleEndian, &d); err != nil {
			return err
		}
		if int(d) != dst.Shape[i] {
			return fmt.Errorf("tensor dim %d is %d, want %d", i, d, dst.Shape[i])
		}
		total *= int(d)
	}
	var buf [4096]byte
	for off := 0; off < total; {
		n := total - off
		if n > len(buf)/4 {
			n = len(buf) / 4
		}
		if _, err := io.ReadFull(r, buf[:n*4]); err != nil {
			return err
		}
		for i := 0; i < n; i++ {
			dst.Data[off+i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
		}
		off += n
	}
	return nil
}

// SaveBinary writes the transformer in the v2 binary format.
func (m *MiniTransformer) SaveBinary(path string) error {
	if m == nil {
		return fmt.Errorf("nil transformer")
	}
	hdr, err := json.Marshal(binaryHeader{Version: 2, Config: m.Config, UseTied: m.UseTiedWeights})
	if err != nil {
		return fmt.Errorf("header: %w", err)
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmp, err)
	}
	w := bufio.NewWriterSize(f, 1<<20)

	fail := func(err error) error {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}

	if _, err := w.Write(nxtf2Magic[:]); err != nil {
		return fail(err)
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(hdr))); err != nil {
		return fail(err)
	}
	if _, err := w.Write(hdr); err != nil {
		return fail(err)
	}
	for _, t := range m.weightTensors() {
		if err := writeTensorBinary(w, t); err != nil {
			return fail(err)
		}
	}
	if err := w.Flush(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// loadMiniTransformerBinary reads a v2 file. The magic has already been
// consumed by the caller's sniffing.
func loadMiniTransformerBinary(r *bufio.Reader, rng *rand.Rand) (*MiniTransformer, error) {
	var hdrLen uint32
	if err := binary.Read(r, binary.LittleEndian, &hdrLen); err != nil {
		return nil, fmt.Errorf("header length: %w", err)
	}
	if hdrLen > 1<<20 {
		return nil, fmt.Errorf("implausible header length %d", hdrLen)
	}
	hdrRaw := make([]byte, hdrLen)
	if _, err := io.ReadFull(r, hdrRaw); err != nil {
		return nil, fmt.Errorf("header: %w", err)
	}
	var hdr binaryHeader
	if err := json.Unmarshal(hdrRaw, &hdr); err != nil {
		return nil, fmt.Errorf("header decode: %w", err)
	}
	if hdr.Version != 2 {
		return nil, fmt.Errorf("unsupported binary version %d", hdr.Version)
	}

	m := NewMiniTransformer(hdr.Config, rng)
	m.UseTiedWeights = hdr.UseTied
	for i, t := range m.weightTensors() {
		if err := readTensorBinary(r, t); err != nil {
			return nil, fmt.Errorf("tensor %d: %w", i, err)
		}
	}
	return m, nil
}
