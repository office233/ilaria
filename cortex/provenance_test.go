package cortex

import (
	"math/rand"
	"strings"
	"testing"
)

// fakeProvenanceTool is a minimal Tool used only to prove that
// Organism.Process()'s provenance correctly names the Tool that answered.
// Its trigger phrase ("quaxfrobinator") is chosen to avoid collisions with
// any built-in Tool's Match() (DateTime, UnitConvert, sqrt/pow, HippoSearch)
// so the fake tool is unambiguously the one that fires.
type fakeProvenanceTool struct{}

func (fakeProvenanceTool) Name() string { return "fake_tool" }

func (fakeProvenanceTool) Match(lower string) bool {
	return strings.Contains(lower, "quaxfrobinator")
}

func (fakeProvenanceTool) Execute(input string) (string, bool) {
	return "42-fake-answer", true
}

// TestProvenance_ToolSource verifies that when a registered Tool answers,
// Organism.LastProvenance() reports source=tool with the tool's own name
// (the name ToolRegistry.Dispatch produces), not just "something matched".
func TestProvenance_ToolSource(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	org := NewOrganism(cfg, rng)
	org.Reasoning.Tools.Register(fakeProvenanceTool{})

	resp := org.Process("please explain quaxfrobinator to me")
	if resp != "42-fake-answer" {
		t.Fatalf("expected fake tool's answer, got %q", resp)
	}

	prov := org.LastProvenance()
	if prov.Source != SourceTool {
		t.Errorf("expected Source=%q, got %q", SourceTool, prov.Source)
	}
	if prov.Tool != "fake_tool" {
		t.Errorf("expected Tool=%q, got %q", "fake_tool", prov.Tool)
	}
}

// TestProvenance_NoToolMatch verifies that when no Tool matches, provenance
// does not claim source=tool. Arithmetic is handled by ReasoningEngine's
// hardcoded skill (not the Tool registry), so this also pins down that the
// hardcoded path is distinguishable from a Tool hit: Source=reasoning and
// Tool="".
func TestProvenance_NoToolMatch(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	org := NewOrganism(cfg, rng)
	org.Reasoning.Tools.Register(fakeProvenanceTool{})

	resp := org.Process("what is 15 + 27")
	if resp == "" {
		t.Fatal("expected a deterministic arithmetic answer")
	}

	prov := org.LastProvenance()
	if prov.Source == SourceTool {
		t.Errorf("did not expect Source=tool for arithmetic input, got Tool=%q", prov.Tool)
	}
	if prov.Source != SourceReasoning {
		t.Errorf("expected Source=%q, got %q", SourceReasoning, prov.Source)
	}
	if prov.Tool != "" {
		t.Errorf("expected empty Tool when Source != tool, got %q", prov.Tool)
	}
}
