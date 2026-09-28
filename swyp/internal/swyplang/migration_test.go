package swyplang

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"math/rand"
	"strings"
	"testing"
)

// This is only the clamp-and-scale expression from ui/web/security.go's
// writeChime, not a WAV encoder: Swyp cannot express its buffers or int16 cast.
const clampSource = `fn scale(x) {
 if x < -1 { x = -1; }
 if x > 1 { x = 1; }
 return x * 32767;
}
fn main() {
 let i = 0; let total = 0;
 while i < 1000 { total = total + scale(i / 250 - 2); i = i + 1; }
 print(total);
}`
const sumSource = `fn main() {
 let i = 0; let total = 0;
 while i < 1000 { total = total + i * i; i = i + 1; }
 print(total);
}`
const fibSource = `fn fib(n) {
 if n <= 1 { return n; }
 return fib(n - 1) + fib(n - 2);
}
fn main() { print(fib(15)); }`

//go:noinline
func goSum(n float64) float64 {
	total := 0.0
	for i := 0.0; i < n; i++ {
		total += i * i
	}
	return total
}

//go:noinline
func goFib(n float64) float64 {
	if n <= 1 {
		return n
	}
	return goFib(n-1) + goFib(n-2)
}

//go:noinline
func goClamp(n float64) float64 {
	total := 0.0
	for i := 0.0; i < n; i++ {
		total += math.Max(-1, math.Min(1, i/250-2)) * 32767
	}
	return total
}

var migrationCases = []struct {
	name, source string
	compute      func() float64
}{
	{"Sum1000", sumSource, func() float64 { return goSum(1000) }},
	{"Fibonacci15", fibSource, func() float64 { return goFib(15) }},
	{"AudioClamp1000", clampSource, func() float64 { return goClamp(1000) }},
}

func TestMigrationParity(t *testing.T) {
	for _, tt := range migrationCases {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Parse(tt.name+".swyp", tt.source)
			if err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err = p.Run(&out, 1_000_000); err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprintln(tt.compute())
			if out.String() != want {
				t.Fatalf("Swyp %q != Go %q", out.String(), want)
			}
		})
	}
}

func TestAudioClampParity(t *testing.T) {
	var source, expected strings.Builder
	source.WriteString(strings.Split(clampSource, "fn main()")[0] + "fn main() {\n")
	values := []float64{-100, -1.0001, -1, -0.5, 0, 0.5, 1, 1.0001, 100}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 1000; i++ {
		values = append(values, float64(float32(rng.Float64()*8-4)))
	}
	for _, x := range values {
		fmt.Fprintf(&source, "print(scale(%.17g));\n", x)
		fmt.Fprintln(&expected, math.Max(-1, math.Min(1, x))*32767)
	}
	source.WriteString("}")
	p, err := Parse("audio-parity.swyp", source.String())
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	if err = p.Run(&got, 1_000_000); err != nil {
		t.Fatal(err)
	}
	if got.String() != expected.String() {
		t.Fatal("audio clamp differs from Go reference")
	}
}

// Warm benchmarks exclude source parsing. Both sides format one result to
// io.Discard. Swyp additionally performs its documented dynamic checks and
// evaluation budget accounting; this compares implementations, not backends.
func BenchmarkMigration(b *testing.B) {
	for _, tt := range migrationCases {
		b.Run(tt.name+"/Go", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				fmt.Fprintln(io.Discard, tt.compute())
			}
		})
		b.Run(tt.name+"/Swyp", func(b *testing.B) {
			p, err := Parse(tt.name+".swyp", tt.source)
			if err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := p.Run(io.Discard, 1_000_000); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
func BenchmarkSwypParse(b *testing.B) {
	for _, tt := range migrationCases {
		b.Run(tt.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := Parse("bench.swyp", tt.source); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
