package sourcefront

import (
	"strings"
	"testing"
)

var preambleResourceBody string
var preambleResourceValue Preamble

// Fixtures are built outside the timer and remain identical before and after.
func BenchmarkPreambleResources(b *testing.B) {
	for _, size := range []struct {
		name  string
		bytes int
	}{{"8KiB", 8 << 10}, {"128KiB", 128 << 10}, {"1MiB", 1 << 20}} {
		for _, mode := range []string{"preamble", "legacy"} {
			prefix := ""
			if mode == "preamble" {
				prefix = "module bench.root;\r\nuse bench.lib;\n"
			}
			start := prefix + "fn main() {}\n"
			source := start + strings.Repeat(" ", size.bytes-len(start))
			b.Run(size.name+"/"+mode, func(b *testing.B) {
				b.ReportAllocs()
				b.SetBytes(int64(len(source)))
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					value, body, err := ParsePreamble("bench.swyp", source)
					if err != nil {
						b.Fatal(err)
					}
					preambleResourceValue, preambleResourceBody = value, body
				}
			})
		}
	}
}
