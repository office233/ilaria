package docs

import (
	"strings"
	"testing"
)

func documentFixture(t *testing.T) *Manager {
	t.Helper()
	m := NewManager()
	if _, err := m.CreateDocument("test-doc", "Test document", "Initial caller supplied content."); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestAIDocs(t *testing.T) {
	m := documentFixture(t)

	doc, err := m.GetDocument("test-doc")
	if err != nil {
		t.Fatalf("Expected default document, got error: %v", err)
	}

	initialWords := doc.WordCount
	if err := m.AppendText("test-doc", "Additional verified paragraph."); err != nil {
		t.Fatal(err)
	}
	doc, err = m.GetDocument("test-doc")
	if err != nil {
		t.Fatal(err)
	}

	if doc.WordCount <= initialWords {
		t.Errorf("Expected word count to increase")
	}
}

func TestDocumentSizeLimit(t *testing.T) {
	m := documentFixture(t)
	doc, err := m.GetDocument("test-doc")
	if err != nil {
		t.Fatal(err)
	}
	m.maxDocumentBytes = len(doc.Content) + 8
	if err := m.AppendText("test-doc", strings.Repeat("x", 64)); err == nil {
		t.Fatal("oversized append unexpectedly accepted")
	}
	if len(doc.Content) > m.maxDocumentBytes {
		t.Fatalf("document grew beyond limit: %d > %d", len(doc.Content), m.maxDocumentBytes)
	}
}

func TestCountWordsNoFieldsAllocationSemantics(t *testing.T) {
	if got := countWords("  unu\n doi\t trei  "); got != 3 {
		t.Fatalf("words=%d want 3", got)
	}
}

func TestAppendWordCountMatchesFullRecount(t *testing.T) {
	m := documentFixture(t)
	doc, err := m.GetDocument("test-doc")
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"one two", "", "three\nfour five", "  six  "} {
		if err := m.AppendText("test-doc", text); err != nil {
			t.Fatal(err)
		}
		doc, err = m.GetDocument("test-doc")
		if err != nil {
			t.Fatal(err)
		}
		if want := countWords(doc.Content); doc.WordCount != want {
			t.Fatalf("text=%q incremental=%d full=%d", text, doc.WordCount, want)
		}
	}
}
