package search

import (
	"strings"
	"testing"
)

func TestCleanText(t *testing.T) {
	raw := "<div><h1>Title</h1><script>alert('bad')</script><p>Clean content</p></div>"
	cleaned := CleanText(raw)

	if strings.Contains(cleaned, "alert") {
		t.Errorf("Expected script to be stripped")
	}
	if !strings.Contains(cleaned, "Title") || !strings.Contains(cleaned, "Clean content") {
		t.Errorf("Expected content to remain, got '%s'", cleaned)
	}
}

func TestSearch(t *testing.T) {
	e := NewEngine()
	res, err := e.Search("golang systems architecture")

	if err != nil {
		t.Fatalf("Unexpected search error: %v", err)
	}

	if res.Query != "golang systems architecture" {
		t.Errorf("Unexpected query in result: %s", res.Query)
	}

	if len(res.Sources) == 0 {
		t.Errorf("Expected sources to be returned")
	}
}
