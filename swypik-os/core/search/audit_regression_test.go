package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBatchCapacityCountsUniqueURLs(t *testing.T) {
	e := NewEngine()
	e.maxDocuments = 1
	first := Document{URL: "https://example.org/", Text: "first revision"}
	last := first
	last.Text = "latest revision"
	if n, err := e.UpsertMany([]Document{first, last}); err != nil || n != 1 {
		t.Fatalf("one unique document should fit the capacity: n=%d err=%v", n, err)
	}
	result, err := e.Search("latest")
	if err != nil || len(result.Sources) != 1 {
		t.Fatalf("last revision was not indexed: result=%+v err=%v", result, err)
	}
}

func TestUpsertDoesNotMutateCallerDocuments(t *testing.T) {
	e := NewEngine()
	e.maxTextBytes = 16
	original := strings.Repeat("text ", 20)
	docs := []Document{{URL: "https://example.org/", Text: original}}
	if _, err := e.UpsertMany(docs); err != nil {
		t.Fatal(err)
	}
	if docs[0].Text != original {
		t.Fatal("resource truncation mutated the caller's document")
	}
}

func TestContentChangesCannotHideBehindReusedHash(t *testing.T) {
	e := NewEngine()
	doc := Document{URL: "https://example.org/", Text: "first content", SHA256: "caller-supplied"}
	if err := e.Upsert(doc); err != nil {
		t.Fatal(err)
	}
	doc.Text = "replacement content"
	if n, err := e.UpsertMany([]Document{doc}); err != nil || n != 1 {
		t.Fatalf("changed content must be written: n=%d err=%v", n, err)
	}
	result, err := e.Search("replacement")
	if err != nil || len(result.Sources) != 1 {
		t.Fatalf("changed content was lost: result=%+v err=%v", result, err)
	}
}

func TestClosedIndexRejectsWritesWithoutLosingDurability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.jsonl")
	e := mustOpen(t, path)
	doc := Document{URL: "https://example.org/", Text: "persisted content"}
	if err := e.Upsert(doc); err != nil {
		t.Fatal(err)
	}
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	doc.Text = "silently lost content"
	if err := e.Upsert(doc); err == nil {
		t.Fatal("closed persistent index accepted a non-durable write")
	}
	if err := e.Delete(doc.URL); err == nil {
		t.Fatal("closed persistent index accepted a non-durable deletion")
	}
	if e.Count() != 1 {
		t.Fatal("rejected mutations changed the existing index")
	}
	if reopened := mustOpen(t, path); reopened.Count() != 1 {
		t.Fatal("existing persisted document was lost")
	}
}

func TestReplayQuarantinesTrailingRecordJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.jsonl")
	raw := "{\"version\":2}\n" + `{"op":"put","doc":{"url":"https://example.org/","text":"valid text"}} {"unexpected":"second object"}` + "\n"
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	e := mustOpen(t, path)
	if len(e.Warnings()) != 1 || e.Count() != 0 {
		t.Fatalf("ambiguous JSON record accepted: count=%d warnings=%v", e.Count(), e.Warnings())
	}
}
