package coder

import "testing"

func FuzzCommandOutput(f *testing.F) {
	f.Add([]byte("hello"), uint16(4))
	f.Add([]byte{0, 255, 13, 10}, uint16(200))
	f.Fuzz(func(t *testing.T, data []byte, repetitions uint16) {
		if len(data) > 16384 {
			data = data[:16384]
		}
		out := &commandOutput{}
		for i := 0; i < int(repetitions%100)+1; i++ {
			n, err := out.Write(data)
			if err != nil || n != len(data) {
				t.Fatal("output writer did not drain command")
			}
			if out.buffer.Len() > maxCommandOutput {
				t.Fatal("unbounded command output")
			}
		}
	})
}
