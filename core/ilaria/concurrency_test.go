package ilaria

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type backendFunc func(context.Context, string, []Message) (string, error)

func (f backendFunc) Chat(ctx context.Context, prompt string, history []Message) (string, error) {
	return f(ctx, prompt, history)
}

func TestCanceledQueuedTurnReturnsWithoutWaitingForInference(t *testing.T) {
	e := NewEngine()
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	e.SetBackend(backendFunc(func(ctx context.Context, prompt string, history []Message) (string, error) {
		calls.Add(1)
		close(entered)
		<-release
		return "answer", nil
	}))
	first := make(chan error, 1)
	go func() { _, err := e.ProcessPromptContext(context.Background(), "first"); first <- err }()
	<-entered
	defer func() { close(release); <-first }()
	ctx, cancel := context.WithCancel(context.Background())
	second := make(chan error, 1)
	go func() { _, err := e.ProcessPromptContext(ctx, "second"); second <- err }()
	cancel()
	select {
	case err := <-second:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled turn is stuck behind active inference")
	}
	if calls.Load() != 1 || len(e.GetHistory()) != 0 {
		t.Fatal("canceled turn reached backend or changed history")
	}
}

func TestCanceledResultIsNotSavedAndQueueRecovers(t *testing.T) {
	e := NewEngine()
	ctx, cancel := context.WithCancel(context.Background())
	e.SetBackend(backendFunc(func(context.Context, string, []Message) (string, error) {
		cancel()
		return "late answer", nil
	}))
	if _, err := e.ProcessPromptContext(ctx, "cancel me"); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if len(e.GetHistory()) != 0 {
		t.Fatal("canceled answer saved")
	}
	e.SetBackend(testBackend{})
	if _, err := e.ProcessPromptContext(context.Background(), "next"); err != nil {
		t.Fatal(err)
	}
	if len(e.GetHistory()) != 2 {
		t.Fatal("queue did not recover")
	}
}
