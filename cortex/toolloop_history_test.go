package cortex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConversationBudgetAndCancellation(t *testing.T) {
	dec := &fakeStepDecoder{script: []int{0, 0, 0, 0, 1, 2}, vocab: 8}
	tok := fakeTokenizer{pieces: map[int]string{1: "OK", 2: ""}}
	r := NewRunner(dec, tok, []int{2}, 7, nil, 1, 2, nil)
	history := []ChatMessage{{"user", "old question"}, {"assistant", "old answer"}, {"user", "recent question"}, {"assistant", "recent answer"}}
	result, err := r.ConversationTurn(context.Background(), history, "new question")
	if err != nil || result.Answer != "OK" {
		t.Fatalf("turn: %+v, %v", result, err)
	}
	text := r.transcript.String()
	if strings.Contains(text, "old question") || !strings.Contains(text, "recent question") {
		t.Fatalf("incorrect history trimming: %s", text)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.ConversationTurn(ctx, nil, "cancelled"); err != context.Canceled {
		t.Fatalf("expected cancellation, got %v", err)
	}
	r.maxSeqLen = 2
	if _, err := r.ConversationTurn(context.Background(), nil, "too long"); err == nil {
		t.Fatal("accepted prompt without generation capacity")
	}
}

func TestReadFileRejectsSymlinkOutsideRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(target, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := NewReadFileChatTool(root).Call(context.Background(), "link.txt"); err == nil {
		t.Fatal("read escaped through symlink")
	}
}
