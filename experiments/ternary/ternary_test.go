package ternary

import (
	"math"
	"math/rand"
	"testing"
)

func TestWeightsAreProgram(t *testing.T) {
	p := Program{1, 3, 2, []int8{1, 1, -1, 0, -1, 1}}
	g, err := Compile(p)
	if err != nil {
		t.Fatal(err)
	}
	y := make([]float64, 2)
	if err = g.EvalInto([]float64{10, 4, 3}, y); err != nil || y[0] != 11 || y[1] != -1 {
		t.Fatalf("%v %v", y, err)
	}
	p.Weights[0] = -1
	mutated, _ := Compile(p)
	if err = mutated.EvalInto([]float64{10, 4, 3}, y); err != nil || y[0] != -9 {
		t.Fatalf("%v %v", y, err)
	}
}

func TestPackedAgainstDense(t *testing.T) {
	r := rand.New(rand.NewSource(58))
	for n := 1; n <= 67; n++ {
		p := Program{Version: 1, Inputs: n, Outputs: 7, Weights: make([]int8, n*7)}
		for i := range p.Weights {
			p.Weights[i] = int8(r.Intn(3) - 1)
		}
		g, err := Compile(p)
		if err != nil {
			t.Fatal(err)
		}
		if g.WeightBytes() != (n*7+4)/5 {
			t.Fatal("packing size")
		}
		for trial := 0; trial < 100; trial++ {
			x := make([]float64, n)
			for i := range x {
				x[i] = float64(r.Intn(201)-100) / 4
			}
			y := make([]float64, 7)
			if err := g.EvalInto(x, y); err != nil {
				t.Fatal(err)
			}
			for row := range y {
				want := 0.0
				for col, v := range x {
					want += float64(p.Weights[row*n+col]) * v
				}
				if y[row] != want {
					t.Fatalf("n=%d row=%d got %v want %v", n, row, y[row], want)
				}
			}
		}
	}
}

func TestValidationAndAliasing(t *testing.T) {
	for _, p := range []Program{{0, 1, 1, []int8{1}}, {1, 0, 1, nil}, {1, 1025, 1, nil}, {1, 1, 1, nil}, {1, 1, 1, []int8{2}}} {
		if _, err := Compile(p); err == nil {
			t.Fatal("accepted invalid program")
		}
	}
	g, _ := Compile(Program{1, 2, 2, []int8{1, 1, 1, -1}})
	x := []float64{3, 2}
	if err := g.EvalInto(x, x); err != nil || x[0] != 5 || x[1] != 1 {
		t.Fatalf("alias %v %v", x, err)
	}
	for _, x := range [][]float64{{1}, {math.NaN(), 1}, {math.Inf(1), 1}, {math.MaxFloat64, math.MaxFloat64}} {
		y := []float64{42, 43}
		if err := g.EvalInto(x, y); err == nil || y[0] != 42 || y[1] != 43 {
			t.Fatal("error must preserve output")
		}
	}
}

var sink float64

func BenchmarkMatrix(b *testing.B) {
	r := rand.New(rand.NewSource(58))
	p := Program{Version: 1, Inputs: 256, Outputs: 256, Weights: make([]int8, 256*256)}
	x := make([]float64, 256)
	y := make([]float64, 256)
	dense := make([]float64, len(p.Weights))
	for i := range p.Weights {
		p.Weights[i] = int8(r.Intn(3) - 1)
		dense[i] = float64(p.Weights[i])
	}
	for i := range x {
		x[i] = float64(r.Intn(100)) / 4
	}
	g, _ := Compile(p)
	b.Run("PackedValidated", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if err := g.EvalInto(x, y); err != nil {
				b.Fatal(err)
			}
			sink = y[0]
		}
	})
	// Deliberately strong baseline: unchecked dense math, same row/column order.
	b.Run("DenseUnchecked", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			for row := range y {
				sum := 0.0
				for col, v := range x {
					sum += dense[row*256+col] * v
				}
				y[row] = sum
			}
			sink = y[0]
		}
	})
	b.Run("Pack", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			compiled, err := Compile(p)
			if err != nil {
				b.Fatal(err)
			}
			sink = float64(compiled.WeightBytes())
		}
	})
}
