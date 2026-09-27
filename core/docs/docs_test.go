package docs

import (
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
