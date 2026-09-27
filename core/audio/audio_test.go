package audio

import (
	"testing"
)

func TestRingBufferLocklessSPSC(t *testing.T) {
	rb := NewRingBuffer(64)

	// Write 16 samples
	in := make([]float32, 16)
	for i := range in {
		in[i] = float32(i + 1)
	}

	written := rb.Write(in)
	if written != 16 {
		t.Errorf("Expected 16 written, got %d", written)
	}

	if rb.Available() != 16 {
		t.Errorf("Expected 16 available, got %d", rb.Available())
	}

	// Read 16 samples
	out := make([]float32, 16)
	read := rb.Read(out)
	if read != 16 {
		t.Errorf("Expected 16 read, got %d", read)
	}

	for i := range out {
		if out[i] != in[i] {
			t.Errorf("Sample %d mismatch: got %f, want %f", i, out[i], in[i])
		}
	}

	if rb.Available() != 0 {
		t.Errorf("Expected 0 available after full read, got %d", rb.Available())
	}
}

func TestRingBufferFullCapacity(t *testing.T) {
	rb := NewRingBuffer(64)

	// Write exact buffer capacity (64 samples)
	in := make([]float32, 64)
	for i := range in {
		in[i] = float32(i * 2)
	}

	written := rb.Write(in)
	if written != 64 {
		t.Errorf("Expected 64 written, got %d", written)
	}

	if rb.Available() != 64 {
		t.Errorf("Expected 64 available in full buffer, got %d", rb.Available())
	}

	out := make([]float32, 64)
	read := rb.Read(out)
	if read != 64 {
		t.Errorf("Expected 64 read, got %d", read)
	}

	for i := range out {
		if out[i] != in[i] {
			t.Errorf("Mismatch at %d: got %f, want %f", i, out[i], in[i])
		}
	}
}

func TestDirectAudioStreamerAndVAD(t *testing.T) {
	streamer := NewDirectAudioStreamer(16000, 1)

	latency, rate, active := streamer.GetTelemetry()
	t.Logf("Audio Pipeline -> Latency: %.2f ms | Rate: %d Hz | Active: %v", latency, rate, active)

	if latency > 3.0 {
		t.Errorf("Expected sub-3ms latency, got %.2f ms", latency)
	}
	if !active {
		t.Errorf("Expected streamer to be active")
	}

	// 1. Test Silent Input (VAD should be false)
	silence := make([]float32, 160)
	vadActive, energy := streamer.CaptureInput(silence)
	if vadActive {
		t.Errorf("Expected silence to produce vadActive=false, got true (energy=%.4f)", energy)
	}

	// 2. Test Loud Speech Input (VAD should trigger true)
	loudSpeech := make([]float32, 160)
	for i := range loudSpeech {
		loudSpeech[i] = 0.45 // Loud signal
	}
	vadActiveLoud, energyLoud := streamer.CaptureInput(loudSpeech)
	if !vadActiveLoud || energyLoud < 0.1 {
		t.Errorf("Expected speech to trigger vadActive=true, got %v (energy=%.4f)", vadActiveLoud, energyLoud)
	}

	// 3. Test Chime Synthesis
	chime := streamer.SynthesizeIlariaChime(880.0, 150) // 150 ms chime
	if len(chime) != (16000*150)/1000 {
		t.Errorf("Unexpected chime length: %d", len(chime))
	}

	// 4. Test Playback Streaming
	written, err := streamer.StreamPlayback(chime)
	if err != nil || written <= 0 {
		t.Fatalf("StreamPlayback failed: written=%d, err=%v", written, err)
	}
}
