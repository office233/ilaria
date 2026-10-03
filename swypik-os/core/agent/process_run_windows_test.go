//go:build windows

package agent

import (
	"strings"
	"testing"

	"swypik-os/core/coder"
)

func TestProcessRunDoesNotExposeParentSecrets(t *testing.T) {
	const (
		ilariaSecret   = "agent-il-7f64bb9f-parent-secret"
		sentinelSecret = "agent-sentinel-3a47de18-parent-secret"
	)
	t.Setenv("ILARIA_API_TOKEN", ilariaSecret)
	t.Setenv("SWYPIK_SENTINEL_SECRET", sentinelSecret)

	tool := toolByName(t, WorkspaceTools(t.TempDir(), coder.Run), "process.run")
	result, err := call(t, tool, `{"command":"if defined ILARIA_API_TOKEN (echo LEAK_ILARIA=%ILARIA_API_TOKEN%) else (echo ILARIA_CLEAN) & if defined SWYPIK_SENTINEL_SECRET (echo LEAK_SENTINEL=%SWYPIK_SENTINEL_SECRET%) else (echo SENTINEL_CLEAN) & if defined SystemRoot (echo SYSTEMROOT_OK) else (echo SYSTEMROOT_MISSING)"}`)
	if err != nil {
		t.Fatal(err)
	}
	if result["status"] != "succeeded" {
		t.Fatalf("process.run failed: %v", result["status"])
	}
	output, _ := result["output"].(string)
	if strings.Contains(output, ilariaSecret) || strings.Contains(output, sentinelSecret) || strings.Contains(output, "LEAK_") {
		t.Fatalf("process.run exposed a parent secret: %q", output)
	}
	for _, marker := range []string{"ILARIA_CLEAN", "SENTINEL_CLEAN", "SYSTEMROOT_OK"} {
		if !strings.Contains(output, marker) {
			t.Fatalf("process.run missing %s: %q", marker, output)
		}
	}
}
