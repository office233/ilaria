package controlkernel

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func testJournalPath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join(t.TempDir(), "control.journal"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func testEvent(kind string, value any) Event {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return Event{Type: kind, Data: raw}
}

func TestEventStoreConcurrentCAS(t *testing.T) {
	store, err := OpenEventStore(testJournalPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	const contenders = 32
	start := make(chan struct{})
	var successes atomic.Int32
	var mismatches atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, appendErr := store.Append("cas", 0, testEvent("cas.append", map[string]int{"caller": i}))
			switch {
			case appendErr == nil:
				successes.Add(1)
			case errors.Is(appendErr, ErrSequenceMismatch):
				mismatches.Add(1)
			default:
				t.Errorf("unexpected append error: %v", appendErr)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if got := successes.Load(); got != 1 {
		t.Fatalf("successes=%d, want 1", got)
	}
	if got := mismatches.Load(); got != contenders-1 {
		t.Fatalf("sequence mismatches=%d, want %d", got, contenders-1)
	}
	if got := store.Sequence("cas"); got != 1 {
		t.Fatalf("sequence=%d, want 1", got)
	}
}

func TestEventStoreRepairsOnlyTornTail(t *testing.T) {
	path := testJournalPath(t)
	store, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := store.Append("test", 0, testEvent("test.first", map[string]bool{"ok": true}))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	validInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	validSize := validInfo.Size()
	partial := encodeFrame([]byte(`{"version":1,"events":[{"torn":true}]}`))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(partial[:frameHeaderLen+5]); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenEventStore(path)
	if err != nil {
		t.Fatalf("torn tail should be repairable: %v", err)
	}
	defer reopened.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != validSize {
		t.Fatalf("journal size after recovery=%d, want %d", info.Size(), validSize)
	}
	events := reopened.Events()
	if len(events) != 1 || events[0].Hash != persisted[0].Hash || reopened.Sequence("test") != 1 {
		t.Fatalf("unexpected replay after torn tail: %#v", events)
	}
}

func TestEventStoreMiddleCorruptionFailsClosed(t *testing.T) {
	path := testJournalPath(t)
	store, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append("test", 0, testEvent("test.first", map[string]int{"value": 1})); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append("test", 1, testEvent("test.second", map[string]int{"value": 2})); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	corruptAt := len(journalMagic) + frameHeaderLen + 7
	if corruptAt >= len(raw) {
		t.Fatal("fixture unexpectedly small")
	}
	raw[corruptAt] ^= 0x40
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}

	broken, err := OpenEventStore(path)
	if broken != nil {
		_ = broken.Close()
	}
	if !errors.Is(err, ErrCorruptJournal) {
		t.Fatalf("open error=%v, want ErrCorruptJournal", err)
	}
}

func TestEventStoreMiddleLengthHeaderCorruptionFailsClosed(t *testing.T) {
	path := testJournalPath(t)
	store, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append("test", 0, testEvent("test.first", map[string]int{"value": 1})); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append("test", 1, testEvent("test.second", map[string]int{"value": 2})); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt a high byte of the first frame's length while leaving the
	// complement untouched. Before the redundant length check, this could look
	// like one giant torn tail and silently discard later valid frames.
	corruptAt := len(journalMagic) + 6
	if corruptAt >= len(raw) {
		t.Fatal("fixture unexpectedly small")
	}
	raw[corruptAt] ^= 0x01
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}

	broken, err := OpenEventStore(path)
	if broken != nil {
		_ = broken.Close()
	}
	if !errors.Is(err, ErrCorruptJournal) {
		t.Fatalf("open error=%v, want ErrCorruptJournal", err)
	}
}

func TestEventStoreHashChainSurvivesReplay(t *testing.T) {
	path := testJournalPath(t)
	store, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Append("test", 0,
		testEvent("test.one", map[string]int{"n": 1}),
		testEvent("test.two", map[string]int{"n": 2}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if first[0].PrevHash != "" || first[1].PrevHash != first[0].Hash {
		t.Fatalf("invalid live hash chain: %#v", first)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenEventStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replayed := reopened.Events()
	if len(replayed) != 2 || replayed[0].Hash != first[0].Hash || replayed[1].Hash != first[1].Hash {
		t.Fatalf("replay changed event chain: %#v", replayed)
	}
}
