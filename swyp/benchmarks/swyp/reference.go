//go:build ignore

package main

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"time"
)

func mandelbrot(width float64) float64 {
	height := width / 2
	py, checksum := 0.0, 0.0
	for py < height {
		px := 0.0
		for px < width {
			cr := px*3.5/width - 2.5
			ci := py*2/height - 1
			zr, zi, count := 0.0, 0.0, 0.0
			for count < 80 && zr*zr+zi*zi <= 4 {
				next := zr*zr - zi*zi + cr
				zi = 2*zr*zi + ci
				zr = next
				count = count + 1
			}
			checksum = checksum + count
			px = px + 1
		}
		py = py + 1
	}
	return checksum
}
func prime(n float64) bool {
	divisor := 2.0
	for divisor*divisor <= n {
		if math.Mod(n, divisor) == 0 {
			return false
		}
		divisor = divisor + 1
	}
	return true
}
func primes(limit float64) float64 {
	n, count := 2.0, 0.0
	for n <= limit {
		if prime(n) {
			count = count + 1
		}
		n = n + 1
	}
	return count
}
func train(epochs float64) float64 {
	weight, bias, epoch := 0.0, 0.0, 0.0
	for epoch < epochs {
		dw, db, i := 0.0, 0.0, 0.0
		for i < 256 {
			x := math.Mod(i, 64)/32 - 1
			target := 2*x + 1
			err := weight*x + bias - target
			dw = dw + 2*err*x
			db = db + 2*err
			i = i + 1
		}
		weight = weight - 0.1*dw/256
		bias = bias - 0.1*db/256
		epoch = epoch + 1
	}
	loss, i := 0.0, 0.0
	for i < 256 {
		x := math.Mod(i, 64)/32 - 1
		err := weight*x + bias - (2*x + 1)
		loss = loss + err*err
		i = i + 1
	}
	loss = loss / 256
	fmt.Printf("WEIGHTS %.17g %.17g %.17g\n", weight, bias, loss)
	return loss
}
func main() {
	if len(os.Args) != 3 {
		os.Exit(2)
	}
	mode, _ := strconv.ParseFloat(os.Args[1], 64)
	size, _ := strconv.ParseFloat(os.Args[2], 64)
	start := time.Now()
	result := 0.0
	if mode == 0 {
		result = mandelbrot(size)
	} else if mode == 1 {
		result = primes(size)
	} else if mode == 3 {
		result = float64(primesInteger(int(size)))
	} else {
		result = train(size)
	}
	fmt.Printf("RESULT %.17g %.17g\n", time.Since(start).Seconds(), result)
}

// A separate idiomatic integer baseline: same prime-counting algorithm, a
// representation Swyp 0.2 cannot express. Do not mix it with float64 timings.
func primesInteger(limit int) int {
	count := 0
	for n := 2; n <= limit; n++ {
		prime := true
		for d := 2; d*d <= n; d++ {
			if n%d == 0 {
				prime = false
				break
			}
		}
		if prime {
			count++
		}
	}
	return count
}
