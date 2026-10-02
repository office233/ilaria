package proactive

import (
	"fmt"
	"strings"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// TriggerType defines conditions for zero-click autonomous execution.
type TriggerType string

const (
	TriggerSchedule TriggerType = "SCHEDULE"
	TriggerTraffic  TriggerType = "TRAFFIC_ALERT"
	TriggerHabit    TriggerType = "HABIT_ROUTINE"
	TriggerDigest   TriggerType = "AUDIO_DIGEST"
	TriggerContext  TriggerType = "CONTEXT_OBSERVATION"
)

// ZeroClickAction represents an autonomous decision made ahead of time for the user.
type ZeroClickAction struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Trigger     TriggerType `json:"trigger"`
	ExecutedAt  time.Time   `json:"executed_at"`
	ObservedAt  time.Time   `json:"observed_at"`
	Status      string      `json:"status"`
	AudioBrief  string      `json:"audio_brief"`
	AutoHandled bool        `json:"auto_handled"`
}

// Engine coordinates preemptive zero-click intelligence.
type Engine struct {
	mu         sync.RWMutex
	actions    []ZeroClickAction
	maxActions int
	nextID     uint64
}

func NewEngine() *Engine {
	return &Engine{
		actions:    make([]ZeroClickAction, 0),
		maxActions: resourcepolicy.Default().MaxGraphCheckpoints,
	}
}

// EvaluateContext records caller-supplied context for review only. No executor
// or capability is connected, so it never claims execution or automatic handling.
func (e *Engine) EvaluateContext(eventDescription string) *ZeroClickAction {
	e.mu.Lock()
	defer e.mu.Unlock()

	eventDescription = strings.TrimSpace(eventDescription)
	if eventDescription == "" || e.nextID == ^uint64(0) {
		return nil
	}
	e.nextID++
	action := ZeroClickAction{
		ID:          fmt.Sprintf("context_%d", e.nextID),
		Title:       "Context for review: " + eventDescription,
		Description: eventDescription,
		Trigger:     TriggerContext,
		ObservedAt:  time.Now().UTC(),
		Status:      "REQUIRES_REVIEW",
		AudioBrief:  "Context recorded for review. No action was executed.",
		AutoHandled: false,
	}

	e.actions = append(e.actions, action)
	if len(e.actions) > e.maxActions {
		copy(e.actions, e.actions[len(e.actions)-e.maxActions:])
		e.actions = e.actions[:e.maxActions]
	}
	copy := action
	return &copy
}

// GetRecentActions returns owned context observations, not claimed executions.
func (e *Engine) GetRecentActions() []ZeroClickAction {
	e.mu.RLock()
	defer e.mu.RUnlock()
	res := make([]ZeroClickAction, len(e.actions))
	copy(res, e.actions)
	return res
}
