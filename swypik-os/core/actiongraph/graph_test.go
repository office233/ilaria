package actiongraph

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCyclicActionGraphAndCompaction(t *testing.T) {
	graph := NewCyclicActionGraph(1000) // 1000 token budget

	// 1. Register 2 interacting nodes
	// Node A: Proposes nominal action
	graph.RegisterNode("planner", func(ctx *GraphContext, in []GraphMessage) ([]GraphMessage, error) {
		ctx.SharedState["last_plan"] = "MOVE_AXIS_X_50MM"
		return []GraphMessage{
			{SenderID: "planner", Payload: "PLAN_READY"},
		}, nil
	})

	// Node B: Verifies and acknowledges action
	graph.RegisterNode("verifier", func(ctx *GraphContext, in []GraphMessage) ([]GraphMessage, error) {
		if len(in) > 0 {
			ctx.SharedState["verified"] = true
		}
		return nil, nil // Terminates cycle
	})

	graph.AddEdge("planner", "verifier")

	// Superstep 0: Planner runs
	done, err := graph.Step(0)
	if err != nil || done {
		t.Fatalf("Superstep 0 failed: done=%v, err=%v", done, err)
	}

	// Superstep 1: Verifier runs on messages from Planner
	done, err = graph.Step(1)
	if err != nil {
		t.Fatalf("Superstep 1 failed: %v", err)
	}

	// Superstep 2: Mailboxes empty -> Halts
	done, err = graph.Step(2)
	if !done {
		t.Errorf("Expected Pregel graph to halt when all mailboxes are empty")
	}

	// Verify shared state was updated across supersteps
	tier, tokens, chkpts := graph.GetStatus()
	if chkpts < 2 {
		t.Errorf("Expected at least 2 checkpoints recorded, got: %d", chkpts)
	}

	// 2. Test 5-Tier Context Compaction
	// Tier 1: 70% threshold (700 tokens)
	graph.AddTokens(720)
	tier, _, _ = graph.GetStatus()
	if tier != TierBudgetReduction {
		t.Errorf("Expected TierBudgetReduction at 72%%, got: %v", tier)
	}

	// Tier 2: 80% threshold (800 tokens)
	graph.AddTokens(90) // Total: 810
	tier, _, _ = graph.GetStatus()
	if tier != TierSnip {
		t.Errorf("Expected TierSnip at 81%%, got: %v", tier)
	}

	// Test Snip text compaction
	longText := "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12"
	snipped := graph.ApplyTextCompaction(longText)
	if !strings.Contains(snipped, "SNIP") {
		t.Errorf("Expected SNIP marker in compacted text, got: %s", snipped)
	}

	// Tier 3: 85% threshold (850 tokens)
	graph.AddTokens(50) // Total: 860
	tier, _, _ = graph.GetStatus()
	if tier != TierMicrocompact {
		t.Errorf("Expected TierMicrocompact at 86%%, got: %v", tier)
	}
	microText := graph.ApplyTextCompaction("some long command output")
	if !strings.Contains(microText, "MICROCOMPACT: sha256=") {
		t.Errorf("Expected sha256 microcompact format, got: %s", microText)
	}

	// Tier 5: 95% threshold -> Auto-Compact
	graph.AddTokens(100) // Total: 960 (96%)
	tier, tokens, _ = graph.GetStatus()
	// Should have triggered auto-compaction and reset usage to 25% (250 tokens)
	if tokens > 300 {
		t.Errorf("Expected tokens to be reduced after auto-compaction, got: %d", tokens)
	}
}

func TestActionGraphBoundsParallelism(t *testing.T) {
	graph := NewCyclicActionGraph(1000)
	graph.maxWorkers = 2
	var active int32
	var peak int32
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("n%d", i)
		graph.RegisterNode(id, func(_ *GraphContext, _ []GraphMessage) ([]GraphMessage, error) {
			n := atomic.AddInt32(&active, 1)
			for {
				old := atomic.LoadInt32(&peak)
				if n <= old || atomic.CompareAndSwapInt32(&peak, old, n) {
					break
				}
			}
			time.Sleep(10 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			return nil, nil
		})
	}
	if _, err := graph.Step(0); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&peak); got > 2 {
		t.Fatalf("peak workers=%d want <=2", got)
	}
}
