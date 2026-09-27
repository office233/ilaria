package audio

import (
	"sync"
	"testing"
)

func TestArbitraryRingSizeAndWrap(t *testing.T) {
	rb := NewRingBuffer(3)
	for iteration := 0; iteration < 10; iteration++ {
		input := []float32{float32(iteration), 2, 3}
		if rb.Write(input) != 3 || rb.Write(input) != 0 {
			t.Fatal("incorrect capacity")
		}
		out := make([]float32, 3)
		if rb.Read(out) != 3 {
			t.Fatal("short read")
		}
		for i := range out {
			if out[i] != input[i] {
				t.Fatalf("iteration %d: %v != %v", iteration, out, input)
			}
		}
	}
}

func TestConcurrentPlayback(t *testing.T) {
	s := NewDirectAudioStreamer(16000, 1)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = s.StreamPlayback([]float32{1, 2, 3}) }()
	}
	wg.Wait()
	if s.playbackRing.Available() != 30 {
		t.Fatal("lost samples")
	}
}
