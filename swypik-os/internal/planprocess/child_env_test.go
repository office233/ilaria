package planprocess

import (
	"strings"
	"testing"
)

func TestChildEnvironmentCapsNativeThreadPoolsAndLeaksNothingElse(t *testing.T) {
	t.Setenv("NEXUS_SENTINEL_SECRET", "must-not-leak")
	env := childEnvironment(Config{MaxThreads: 2, MemoryLimitBytes: 4096, GCPercent: 50})
	joined := "\n" + strings.Join(env, "\n") + "\n"
	for _, want := range []string{"GOMAXPROCS=2", "OMP_NUM_THREADS=2", "OPENBLAS_NUM_THREADS=2", "MKL_NUM_THREADS=2", "GOMEMLIMIT=4096", "GOGC=50"} {
		if !strings.Contains(joined, "\n"+want+"\n") {
			t.Fatalf("child environment lacks %s: %v", want, env)
		}
	}
	if strings.Contains(joined, "NEXUS_SENTINEL_SECRET") {
		t.Fatalf("child environment leaked parent variable: %v", env)
	}
}
