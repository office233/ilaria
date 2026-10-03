package docs

import (
	"sync"
	"testing"
)

func TestManagerStartsEmptyAndReturnsSnapshots(t *testing.T) {
	m := NewManager()
	if _, err := m.GetDocument("doc_welcome"); err == nil || len(m.docs) != 0 {
		t.Fatal("new manager invented a user document")
	}
	created, err := m.CreateDocument("document", "User title", "User content")
	if err != nil {
		t.Fatal(err)
	}
	created.Content, created.WordCount = "mutated", 999
	first, err := m.GetDocument("document")
	if err != nil || first.Content != "User content" || first.WordCount != 2 {
		t.Fatalf("create result aliases internal state: %+v %v", first, err)
	}
	first.Content, first.WordCount = "mutated", 999
	second, err := m.GetDocument("document")
	if err != nil || second.Content != "User content" || second.WordCount != 2 {
		t.Fatal("get result aliases internal state")
	}
	if _, err := m.CreateDocument("document", "Replacement", "Overwrite"); err == nil {
		t.Fatal("creation overwrote an existing user document")
	}
}

func TestDocumentSnapshotMutationDoesNotRaceEditing(t *testing.T) {
	m := documentFixture(t)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			if err := m.AppendText("test-doc", "one word"); err != nil {
				t.Error(err)
			}
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			doc, err := m.GetDocument("test-doc")
			if err != nil {
				t.Error(err)
				return
			}
			doc.Content, doc.WordCount = "external", -1
		}
	}()
	workers.Wait()
	doc, err := m.GetDocument("test-doc")
	if err != nil || doc.WordCount != countWords(doc.Content) {
		t.Fatal("document metrics were corrupted")
	}
}
