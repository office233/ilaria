package pce_transfer_v1

import (
	"fmt"
	"testing"
)

func TestPublicSyntheticReplayAlwaysRuns(t *testing.T) {
	tasks := make([]task, 12)
	for i := range tasks {
		action := fmt.Sprintf("set synthetic counter to %d", i+1)
		tasks[i] = task{ID: fmt.Sprintf("public-%02d", i), Domain: "public.synthetic.counter", TeachState: fmt.Sprintf("counter=%d", i), Action: action, Result: action, EvalPrompt: "next counter", Expected: action}
	}
	verifyReplayTasks(t, tasks)
}
