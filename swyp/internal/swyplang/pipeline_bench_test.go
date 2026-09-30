package swyplang

import (
	"testing"

	"swyp-lang/internal/coreir"
)

const benchmarkCoreSource = `
fn prime(n:i64)->bool {
  let d:i64=2;
  while d*d<=n {
    if n%d==0 { return false; }
    d=d+1;
  }
  return true;
}
fn count_primes(limit:i64)->i64 {
  let n:i64=2;
  let count:i64=0;
  while n<=limit {
    if prime(n) { count=count+1; }
    n=n+1;
  }
  return count;
}
fn main(){}
`

func BenchmarkCoreFrontendPipeline(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		p, err := ParseCore("bench.swyp", benchmarkCoreSource)
		if err != nil {
			b.Fatal(err)
		}
		m, err := p.CoreIR("count_primes")
		if err != nil {
			b.Fatal(err)
		}
		m, _, err = coreir.Optimize(m)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := coreir.EmitNativeC(m, "count_primes", coreir.NativeFast); err != nil {
			b.Fatal(err)
		}
	}
}
