package resource

import (
	"os"
	"runtime"
	"testing"
)

func TestProcessUsageMeasuresCurrentProcess(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("native process sampler supports Windows and Linux")
	}
	sampler, err := NewProcessSampler(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	defer sampler.Close()
	first, err := sampler.Sample()
	if err != nil || first.CPUTime < 0 || first.RSSBytes == 0 || first.PeakRSSBytes < first.RSSBytes {
		t.Fatalf("invalid measured process usage: %+v %v", first, err)
	}
	second, err := sampler.Sample()
	if err != nil || second.CPUTime < first.CPUTime {
		t.Fatalf("CPU time moved backwards: %+v %v", second, err)
	}
	if _, err := NewProcessSampler(-1); err == nil {
		t.Fatal("accepted invalid process identity")
	}
	if err := sampler.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sampler.Close(); err != nil {
		t.Fatal("second close must not close a reused native handle", err)
	}
	if _, err := sampler.Sample(); err == nil {
		t.Fatal("sampled a closed native handle")
	}
}
