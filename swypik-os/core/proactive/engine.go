package proactive

import (
	"fmt"
	"sync"
	"time"
)

// TriggerType defines conditions for zero-click autonomous execution.
type TriggerType string

const (
	TriggerSchedule TriggerType = "SCHEDULE"
	TriggerTraffic  TriggerType = "TRAFFIC_ALERT"
	TriggerHabit    TriggerType = "HABIT_ROUTINE"
	TriggerDigest   TriggerType = "AUDIO_DIGEST"
)

// ZeroClickAction represents an autonomous decision made ahead of time for the user.
type ZeroClickAction struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Trigger     TriggerType `json:"trigger"`
	ExecutedAt  time.Time   `json:"executed_at"`
	AudioBrief  string      `json:"audio_brief"`
	AutoHandled bool        `json:"auto_handled"`
}

// Engine coordinates preemptive zero-click intelligence.
type Engine struct {
	mu      sync.RWMutex
	actions []ZeroClickAction
}

func NewEngine() *Engine {
	e := &Engine{
		actions: make([]ZeroClickAction, 0),
	}
	e.seedProactiveActions()
	return e
}

func (e *Engine) seedProactiveActions() {
	e.actions = append(e.actions, ZeroClickAction{
		ID:          "act_zero_01",
		Title:       "Preemptive Meeting Departure",
		Description: "Detected heavy traffic on route to 10:00 meeting. Reserved transport 20 min early.",
		Trigger:     TriggerTraffic,
		ExecutedAt:  time.Now(),
		AudioBrief:  "Good morning. Traffic on your route has slowed down. I've booked your ride for 09:20 and summarized your morning emails in your ear.",
		AutoHandled: true,
	})
}

// EvaluateContext inspects incoming sensor and calendar events and triggers autonomous actions.
func (e *Engine) EvaluateContext(eventDescription string) *ZeroClickAction {
	e.mu.Lock()
	defer e.mu.Unlock()

	action := ZeroClickAction{
		ID:          fmt.Sprintf("act_%d", time.Now().UnixNano()),
		Title:       "Autonomous Decision: " + eventDescription,
		Description: fmt.Sprintf("Zero-click action dispatched for context '%s' without manual intervention.", eventDescription),
		Trigger:     TriggerHabit,
		ExecutedAt:  time.Now(),
		AudioBrief:  fmt.Sprintf("I noticed %s. All preparations have been completed automatically.", eventDescription),
		AutoHandled: true,
	}

	e.actions = append(e.actions, action)
	if len(e.actions) > 100 {
		copy(e.actions, e.actions[len(e.actions)-100:])
		e.actions = e.actions[:100]
	}
	return &e.actions[len(e.actions)-1]
}

// GetRecentActions returns all zero-click autonomous executions.
func (e *Engine) GetRecentActions() []ZeroClickAction {
	e.mu.RLock()
	defer e.mu.RUnlock()
	res := make([]ZeroClickAction, len(e.actions))
	copy(res, e.actions)
	return res
}
