package docs

import (
	"strings"
	"testing"
)

func TestAIDocs(t *testing.T) {
	m := NewManager()

	doc, err := m.GetDocument("doc_welcome")
	if err != nil {
		t.Fatalf("Expected default document, got error: %v", err)
	}

	initialWords := doc.WordCount
	m.AppendText("doc_welcome", "Additional verified paragraph.")

	if doc.WordCount <= initialWords {
		t.Errorf("Expected word count to increase")
	}
}

func TestDocumentSizeLimit(t *testing.T) {
	m := NewManager()
	doc, err := m.GetDocument("doc_welcome")
	if err != nil {
		t.Fatal(err)
	}
	m.maxDocumentBytes = len(doc.Content) + 8
	if err := m.AppendText("doc_welcome", strings.Repeat("x", 64)); err == nil {
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
	m := NewManager()
	doc, err := m.GetDocument("doc_welcome")
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"one two", "", "three\nfour five", "  six  "} {
		if err := m.AppendText("doc_welcome", text); err != nil {
			t.Fatal(err)
		}
		if want := countWords(doc.Content); doc.WordCount != want {
			t.Fatalf("text=%q incremental=%d full=%d", text, doc.WordCount, want)
		}
	}
}
