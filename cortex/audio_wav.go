package cortex

// audio_wav.go — minimal PCM WAV reader (RIFF/WAVE container, "fmt " +
// "data" chunks; 16-bit integer PCM or 32-bit IEEE-float PCM samples, any
// channel count downmixed to mono by averaging) — the only WAV decoding
// cortex/audio_whisper.go's LogMel front end and cmd/ilaria-hear need. Not
// a general-purpose WAV library: no compressed formats (ADPCM, mu-law,
// ...), no WAVE_FORMAT_EXTENSIBLE sub-format dispatch beyond skipping the
// extra fmt-chunk bytes. forge/multimodal/dump_audio_reference.py writes
// its test_tone.wav fixture via Python's stdlib `wave` module (16-bit PCM
// mono), which this file was written and tested against.

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
)

// DecodeWAV reads a canonical PCM WAV file from r and returns its samples
// downmixed to mono float32 in [-1,1] (16-bit PCM: sample/32768; 32-bit
// float PCM: passed through unchanged) plus its sample rate in Hz. Chunks
// other than "fmt " and "data" (e.g. "LIST", "fact") are read and
// discarded.
func DecodeWAV(r io.Reader) (samples []float32, sampleRate int, err error) {
	var riffHdr [12]byte
	if _, err := io.ReadFull(r, riffHdr[:]); err != nil {
		return nil, 0, fmt.Errorf("wav: read RIFF header: %w", err)
	}
	if string(riffHdr[0:4]) != "RIFF" || string(riffHdr[8:12]) != "WAVE" {
		return nil, 0, fmt.Errorf("wav: not a RIFF/WAVE file (got %q/%q)", riffHdr[0:4], riffHdr[8:12])
	}

	var (
		haveFmt                        bool
		audioFormat, numChannels, bits uint16
		rate                           uint32
		data                           []byte
	)

	for {
		var chunkHdr [8]byte
		if _, err := io.ReadFull(r, chunkHdr[:]); err != nil {
			break // clean EOF (no more chunks) or a truncated trailing header — either way, stop reading chunks
		}
		id := string(chunkHdr[0:4])
		size := binary.LittleEndian.Uint32(chunkHdr[4:8])

		body := make([]byte, size)
		if _, err := io.ReadFull(r, body); err != nil {
			return nil, 0, fmt.Errorf("wav: read chunk %q body (%d bytes): %w", id, size, err)
		}
		if size%2 == 1 { // chunks are padded to an even byte count
			var pad [1]byte
			io.ReadFull(r, pad[:])
		}

		switch id {
		case "fmt ":
			if len(body) < 16 {
				return nil, 0, fmt.Errorf("wav: fmt chunk too short (%d bytes, want >= 16)", len(body))
			}
			audioFormat = binary.LittleEndian.Uint16(body[0:2])
			numChannels = binary.LittleEndian.Uint16(body[2:4])
			rate = binary.LittleEndian.Uint32(body[4:8])
			bits = binary.LittleEndian.Uint16(body[14:16])
			haveFmt = true
		case "data":
			data = body
		}
	}

	if !haveFmt {
		return nil, 0, fmt.Errorf("wav: no fmt chunk found")
	}
	if data == nil {
		return nil, 0, fmt.Errorf("wav: no data chunk found")
	}
	if numChannels == 0 {
		return nil, 0, fmt.Errorf("wav: fmt chunk declares 0 channels")
	}

	var readSample func(off int) float32 // one channel-sample at byte offset off within data
	bytesPerSample := int(bits) / 8
	switch {
	case audioFormat == 1 && bits == 16: // PCM, 16-bit signed integer
		readSample = func(off int) float32 {
			v := int16(binary.LittleEndian.Uint16(data[off : off+2]))
			return float32(v) / 32768.0
		}
	case audioFormat == 3 && bits == 32: // IEEE float, 32-bit
		readSample = func(off int) float32 {
			return math.Float32frombits(binary.LittleEndian.Uint32(data[off : off+4]))
		}
	default:
		return nil, 0, fmt.Errorf("wav: unsupported format (audioFormat=%d bitsPerSample=%d) — only 16-bit PCM and 32-bit float are implemented", audioFormat, bits)
	}

	ch := int(numChannels)
	frameBytes := bytesPerSample * ch
	if frameBytes == 0 {
		return nil, 0, fmt.Errorf("wav: zero-width frame (bitsPerSample=%d numChannels=%d)", bits, numChannels)
	}
	numFrames := len(data) / frameBytes
	out := make([]float32, numFrames)
	for i := 0; i < numFrames; i++ {
		base := i * frameBytes
		var sum float32
		for c := 0; c < ch; c++ {
			sum += readSample(base + c*bytesPerSample)
		}
		out[i] = sum / float32(ch)
	}
	return out, int(rate), nil
}
