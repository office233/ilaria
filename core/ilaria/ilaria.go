// Package ilaria is the SwypikOS client for the Ilaria model service. The model
// itself (weights, training, inference) lives outside this repository; this
// package only transports conversation turns and keeps local chat history.
package ilaria

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Message is one conversational turn kept in local memory.
type Message struct {
	ID        string `json:"id"`
	Sender    string `json:"sender"` // "user" or "ilaria"
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
}

const maxHistory = 100

// Engine serializes turns to one Backend and records only successful exchanges.
type Engine struct {
	mu       sync.RWMutex
	turnGate chan struct{}
	backend  Backend
	messages []Message
}

// NewEngine returns an engine with no backend. Requests fail explicitly until
// SetBackend supplies a configured service; nothing is simulated.
func NewEngine() *Engine {
	return &Engine{turnGate: make(chan struct{}, 1)}
}

// SetBackend replaces the service after any in-flight turn finishes.
func (e *Engine) SetBackend(b Backend) {
	e.turnGate <- struct{}{}
	defer func() { <-e.turnGate }()
	e.backend = b
}

// ProcessPromptContext sends one turn with the recent history. A canceled or
// failed turn leaves the history unchanged.
func (e *Engine) ProcessPromptContext(ctx context.Context, prompt string) (string, error) {
	select {
	case e.turnGate <- struct{}{}:
		defer func() { <-e.turnGate }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if strings.TrimSpace(prompt) == "" {
		return "", fmt.Errorf("prompt must not be empty")
	}
	if e.backend == nil {
		return "", fmt.Errorf("Ilaria service is not configured")
	}
	history := e.GetHistory()
	// The service accepts ten complete turns. The model also enforces its token budget.
	if len(history) > 20 {
		history = history[len(history)-20:]
	}
	reply, err := e.backend.Chat(ctx, prompt, history)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	e.messages = append(e.messages,
		Message{ID: fmt.Sprintf("msg_%d", now.UnixNano()), Sender: "user", Text: prompt, Timestamp: now.Format("15:04")},
		Message{ID: fmt.Sprintf("msg_%d", now.UnixNano()+1), Sender: "ilaria", Text: reply, Timestamp: now.Format("15:04")})
	if len(e.messages) > maxHistory {
		e.messages = append([]Message(nil), e.messages[len(e.messages)-maxHistory:]...)
	}
	return reply, nil
}

// Complete sends a single stateless prompt (used by the agent planner). It is
// serialized with chat turns but never recorded in the chat history.
func (e *Engine) Complete(ctx context.Context, prompt string) (string, error) {
	select {
	case e.turnGate <- struct{}{}:
		defer func() { <-e.turnGate }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if e.backend == nil {
		return "", fmt.Errorf("Ilaria service is not configured")
	}
	return e.backend.Chat(ctx, prompt, nil)
}

// GetHistory returns a copy of all conversation messages, oldest first.
func (e *Engine) GetHistory() []Message {
	e.mu.RLock()
	defer e.mu.RUnlock()
	res := make([]Message, len(e.messages))
	copy(res, e.messages)
	return res
}

// ClearHistory starts a new conversation.
func (e *Engine) ClearHistory() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.messages = nil
}
