// Package ternary executes a bounded linear program encoded by ternary weights.
// The fixed instruction is y = W*x; weights alone do not specify a general language.
package ternary

import (
	"fmt"
	"math"
)

const MaxDimension = 1024

// Program uses row-major weights. Each weight must be -1, 0, or 1.
type Program struct {
	Version int    `json:"version"`
	Inputs  int    `json:"inputs"`
	Outputs int    `json:"outputs"`
	Weights []int8 `json:"weights"`
}

// Packed stores five base-3 digits per byte (1.6 bits/weight for full groups).
// Dimensions and the slice header are additional storage, not included in that rate.
type Packed struct {
	inputs, outputs int
	data            []byte
}

func Compile(p Program) (*Packed, error) {
	if p.Version != 1 || p.Inputs < 1 || p.Outputs < 1 || p.Inputs > MaxDimension || p.Outputs > MaxDimension || len(p.Weights) != p.Inputs*p.Outputs {
		return nil, fmt.Errorf("invalid version, dimensions, or weight count")
	}
	g := &Packed{inputs: p.Inputs, outputs: p.Outputs, data: make([]byte, (len(p.Weights)+4)/5)}
	for i, w := range p.Weights {
		if w < -1 || w > 1 {
			return nil, fmt.Errorf("weight %d must be -1, 0, or 1", i)
		}
		power := byte(1)
		for j := 0; j < i%5; j++ {
			power *= 3
		}
		g.data[i/5] += byte(w+1) * power
	}
	return g, nil
}

func (g *Packed) WeightBytes() int { return len(g.data) }

func (g *Packed) EvalInto(x, y []float64) error {
	if len(x) != g.inputs || len(y) != g.outputs {
		return fmt.Errorf("input/output dimension mismatch")
	}
	for _, v := range x {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("non-finite input")
		}
	}
	// Temporary outputs make overlapping buffers safe and leave y untouched on error.
	var scratch [MaxDimension]float64
	k := 0
	var digits byte
	for row := 0; row < g.outputs; row++ {
		sum := 0.0
		for col := 0; col < g.inputs; col++ {
			if k%5 == 0 {
				digits = g.data[k/5]
			}
			w := int8(digits%3) - 1
			digits /= 3
			if w == 1 {
				sum += x[col]
			} else if w == -1 {
				sum -= x[col]
			}
			k++
		}
		if math.IsNaN(sum) || math.IsInf(sum, 0) {
			return fmt.Errorf("non-finite output at row %d", row)
		}
		scratch[row] = sum
	}
	copy(y, scratch[:g.outputs])
	return nil
}
