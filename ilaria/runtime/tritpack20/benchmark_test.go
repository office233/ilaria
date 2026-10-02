package tritpack20

import "testing"

func BenchmarkPack1MiTrits(b *testing.B) {
	trits := make([]int8, 1<<20)
	for i := range trits {
		trits[i] = int8(i%3) - 1
	}
	payloadBytes, err := PackedBytes(uint64(len(trits)), testLimits())
	if err != nil {
		b.Fatal(err)
	}
	payload := make([]byte, payloadBytes)

	b.ReportAllocs()
	b.SetBytes(int64(payloadBytes))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := Pack(payload, trits); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMatVec768x768(b *testing.B) {
	const (
		in  = 768
		out = 768
	)
	limits := testLimits()
	trits := make([]int8, in*out)
	for i := range trits {
		trits[i] = int8((i*7)%3) - 1
	}
	snapshot, err := NewSnapshot(in, out, 0.03125, trits, limits)
	if err != nil {
		b.Fatal(err)
	}
	activations := make([]int8, in)
	for i := range activations {
		activations[i] = int8((i*29)%255 - 128)
	}
	dst := make([]float32, out)

	b.ReportAllocs()
	b.SetBytes(int64(snapshot.PayloadBytes()))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := snapshot.MatVec(dst, activations, 0.0078125); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseSnapshot768x768(b *testing.B) {
	const (
		in  = 768
		out = 768
	)
	limits := testLimits()
	trits := make([]int8, in*out)
	for i := range trits {
		trits[i] = int8(i%3) - 1
	}
	snapshot, err := NewSnapshot(in, out, 0.03125, trits, limits)
	if err != nil {
		b.Fatal(err)
	}
	encoded := snapshot.MarshalBinary()

	b.ReportAllocs()
	b.SetBytes(int64(len(encoded)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		parsed, err := ParseSnapshot(encoded, limits)
		if err != nil {
			b.Fatal(err)
		}
		if parsed.In() != in {
			b.Fatal("unexpected parsed shape")
		}
	}
}
