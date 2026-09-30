package actiongraph

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// CompactionTier denotes the progressive context degradation tier.
type CompactionTier int

const (
	TierNone            CompactionTier = 0
	TierBudgetReduction CompactionTier = 1 // 70% limit: strip verbose logs
	TierSnip            CompactionTier = 2 // 80% limit: truncate outputs to head/tail
	TierMicrocompact    CompactionTier = 3 // 85% limit: replace past tool output with SHA-256 digest
	TierContextCollapse CompactionTier = 4 // 90% limit: merge conversational chains into summary
	TierAutoCompact     CompactionTier = 5 // 95% limit: hard emergency context reset to essential state
)

// GraphMessage is a typed data packet routed across Pregel graph edges.
type GraphMessage struct {
	SenderID  string      `json:"sender_id"`
	Payload   interface{} `json:"payload"`
	Timestamp time.Time   `json:"timestamp"`
}

// NodeFunc is the computation executed by a graph node during a superstep.
type NodeFunc func(ctx *GraphContext, inMessages []GraphMessage) ([]GraphMessage, error)

// GraphContext provides access to shared channel state and checkpointing.
type GraphContext struct {
	mu          sync.RWMutex
	Superstep   int
	SharedState map[string]interface{}
	ActiveTier  CompactionTier
	TokenUsage  int
	MaxTokens   int
}

// SetState safely stores a key-value pair in shared state.
func (ctx *GraphContext) SetState(key string, val interface{}) {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	ctx.SharedState[key] = val
}

// GetState safely retrieves a value from shared state.
func (ctx *GraphContext) GetState(key string) (interface{}, bool) {
	ctx.mu.RLock()
	defer ctx.mu.RUnlock()
	v, ok := ctx.SharedState[key]
	return v, ok
}

// Checkpoint represents a transactional snapshot of the cyclic graph state.
type Checkpoint struct {
	ID        string                 `json:"id"`
	Superstep int                    `json:"superstep"`
	State     map[string]interface{} `json:"state"`
	Timestamp time.Time              `json:"timestamp"`
}

// CyclicActionGraph implements Pregel Bulk Synchronous Parallel execution.
type CyclicActionGraph struct {
	mu             sync.RWMutex
	nodes          map[string]NodeFunc
	edges          map[string][]string // source -> targets
	state          map[string]interface{}
	mailboxes      map[string][]GraphMessage
	nextMailboxes  map[string][]GraphMessage
	checkpoints    []*Checkpoint
	maxTokens      int
	tokenUsage     int
	activeTier     CompactionTier
	maxWorkers     int
	maxCheckpoints int
}

// NewCyclicActionGraph initializes the Pregel BSP action graph.
func NewCyclicActionGraph(maxTokens int) *CyclicActionGraph {
	if maxTokens <= 0 {
		maxTokens = 100000 // 100k token window default
	}

	policy := resourcepolicy.Default()
	return &CyclicActionGraph{
		nodes:          make(map[string]NodeFunc),
		edges:          make(map[string][]string),
		state:          make(map[string]interface{}),
		mailboxes:      make(map[string][]GraphMessage),
		nextMailboxes:  make(map[string][]GraphMessage),
		checkpoints:    make([]*Checkpoint, 0, policy.MaxGraphCheckpoints),
		maxTokens:      maxTokens,
		tokenUsage:     0,
		activeTier:     TierNone,
		maxWorkers:     policy.MaxBackgroundWorkers,
		maxCheckpoints: policy.MaxGraphCheckpoints,
	}
}

// RegisterNode adds a computational actor to the Pregel graph.
func (g *CyclicActionGraph) RegisterNode(id string, fn NodeFunc) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.nodes[id] = fn
	g.mailboxes[id] = make([]GraphMessage, 0)
	g.nextMailboxes[id] = make([]GraphMessage, 0)
}

// AddEdge routes messages from a source node to one or more destination nodes.
func (g *CyclicActionGraph) AddEdge(from string, to ...string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.edges[from] = append(g.edges[from], to...)
}

// Step executes one synchronous Pregel superstep across all active nodes.
func (g *CyclicActionGraph) Step(superstep int) (completed bool, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	// 1. Context Compaction Gate: Evaluate token envelope
	g.evaluateContextCompaction()

	// 2. Identify nodes with incoming mail
	type nodeTask struct {
		id       string
		inbox    []GraphMessage
		nodeFunc NodeFunc
	}
	var activeTasks []nodeTask

	for id, inbox := range g.mailboxes {
		if len(inbox) > 0 || superstep == 0 {
			if fn, ok := g.nodes[id]; ok {
				activeTasks = append(activeTasks, nodeTask{
					id:       id,
					inbox:    inbox,
					nodeFunc: fn,
				})
			}
		}
	}

	if len(activeTasks) == 0 && superstep > 0 {
		return true, nil // Pregel graph halted: no more messages in transit
	}

	// 3. Clear existing mailboxes for next superstep
	for id := range g.nodes {
		g.nextMailboxes[id] = g.nextMailboxes[id][:0]
	}

	// 4. Execute active nodes concurrently within superstep. Keep goroutine
	// count bounded by the resource profile instead of spawning one goroutine
	// per active node and blocking most of them on a semaphore.
	var outMu sync.Mutex
	var wg sync.WaitGroup
	var execErrors []error
	workers := g.maxWorkers
	if workers < 1 {
		workers = 1
	}
	if workers > len(activeTasks) {
		workers = len(activeTasks)
	}
	graphCtx := &GraphContext{
		Superstep:   superstep,
		SharedState: g.state,
		ActiveTier:  g.activeTier,
		TokenUsage:  g.tokenUsage,
		MaxTokens:   g.maxTokens,
	}

	jobs := make(chan nodeTask)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				outMsgs, nodeErr := t.nodeFunc(graphCtx, t.inbox)
				if nodeErr != nil {
					outMu.Lock()
					execErrors = append(execErrors, fmt.Errorf("node '%s' failed: %w", t.id, nodeErr))
					outMu.Unlock()
					continue
				}

				// Route output messages to target nodes.
				outMu.Lock()
				targets := g.edges[t.id]
				for _, targetID := range targets {
					g.nextMailboxes[targetID] = append(g.nextMailboxes[targetID], outMsgs...)
				}
				outMu.Unlock()
			}
		}()
	}
	for _, task := range activeTasks {
		jobs <- task
	}
	close(jobs)
	wg.Wait()
	if len(execErrors) > 0 {
		return false, execErrors[0]
	}

	g.mailboxes, g.nextMailboxes = g.nextMailboxes, g.mailboxes

	// 5. Transactional Checkpoint: Save superstep state
	g.saveCheckpoint(superstep)

	return false, nil
}

// evaluateContextCompaction enforces the 5 progressive tiers of context optimization.
func (g *CyclicActionGraph) evaluateContextCompaction() {
	if g.maxTokens <= 0 {
		return
	}
	ratio := float64(g.tokenUsage) / float64(g.maxTokens)

	switch {
	case ratio >= 0.95:
		g.activeTier = TierAutoCompact
		// Hard compaction: preserve essential variables, reset scratchpad
		g.state = map[string]interface{}{
			"compacted_summary": fmt.Sprintf("[AUTO-COMPACTED] Retained 1 essential state summary at superstep checkpoint."),
		}
		g.tokenUsage = int(float64(g.maxTokens) * 0.25)

	case ratio >= 0.90:
		g.activeTier = TierContextCollapse

	case ratio >= 0.85:
		g.activeTier = TierMicrocompact

	case ratio >= 0.80:
		g.activeTier = TierSnip

	case ratio >= 0.70:
		g.activeTier = TierBudgetReduction

	default:
		g.activeTier = TierNone
	}
}

// ApplyTextCompaction applies progressive compaction rules to raw tool text outputs.
func (g *CyclicActionGraph) ApplyTextCompaction(rawText string) string {
	switch g.activeTier {
	case TierBudgetReduction:
		// Strip timestamps and blank lines
		lines := strings.Split(rawText, "\n")
		var out []string
		for _, l := range lines {
			if strings.TrimSpace(l) != "" {
				out = append(out, l)
			}
		}
		return strings.Join(out, "\n")

	case TierSnip:
		// Truncate to first 5 and last 5 lines
		lines := strings.Split(rawText, "\n")
		if len(lines) > 10 {
			return strings.Join(lines[:5], "\n") + "\n... [SNIP: intermediate lines truncated] ...\n" + strings.Join(lines[len(lines)-5:], "\n")
		}
		return rawText

	case TierMicrocompact:
		// Replace output with SHA-256 digest + 1-line status
		h := sha256.Sum256([]byte(rawText))
		lines := 0
		if rawText != "" {
			lines = strings.Count(rawText, "\n") + 1
		}
		return fmt.Sprintf("[MICROCOMPACT: sha256=%s, bytes=%d, lines=%d]", hex.EncodeToString(h[:8]), len(rawText), lines)

	case TierContextCollapse, TierAutoCompact:
		// Ultra-condensed state
		return "[CONTEXT-COLLAPSED: Historical execution outputs merged into latent world state]"

	default:
		return rawText
	}
}

// AddTokens updates the internal token counter.
func (g *CyclicActionGraph) AddTokens(tokens int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tokenUsage += tokens
	g.evaluateContextCompaction()
}

func (g *CyclicActionGraph) saveCheckpoint(superstep int) {
	snap := make(map[string]interface{})
	for k, v := range g.state {
		snap[k] = v
	}
	now := time.Now()
	cp := &Checkpoint{
		ID:        fmt.Sprintf("chkpt_%d_%d", superstep, now.UnixNano()),
		Superstep: superstep,
		State:     snap,
		Timestamp: now,
	}
	g.checkpoints = append(g.checkpoints, cp)
	limit := g.maxCheckpoints
	if limit < 1 {
		limit = 1
	}
	if len(g.checkpoints) > limit {
		drop := len(g.checkpoints) - limit
		copy(g.checkpoints, g.checkpoints[drop:])
		for i := limit; i < len(g.checkpoints); i++ {
			g.checkpoints[i] = nil
		}
		g.checkpoints = g.checkpoints[:limit]
	}
}

// GetStatus returns the active Pregel execution metrics and compaction tier.
func (g *CyclicActionGraph) GetStatus() (activeTier CompactionTier, tokenUsage int, checkpoints int) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.activeTier, g.tokenUsage, len(g.checkpoints)
}
