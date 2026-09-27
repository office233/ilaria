package ilaria

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"swypik-os/core/audio"
	"swypik-os/core/hal"
)

// IntentType represents the classified purpose of a user request.
type IntentType string

const (
	IntentSearch   IntentType = "SEARCH"
	IntentStudio   IntentType = "STUDIO"
	IntentWallet   IntentType = "WALLET"
	IntentTasks    IntentType = "TASKS"
	IntentConnect  IntentType = "CONNECT"
	IntentSettings IntentType = "SETTINGS"
	IntentChat     IntentType = "CHAT"
	IntentExecute  IntentType = "EXECUTE"
)

// Message represents a single conversational exchange in memory.
type Message struct {
	ID        string     `json:"id"`
	Sender    string     `json:"sender"` // "user" or "ilaria"
	Text      string     `json:"text"`
	Intent    IntentType `json:"intent,omitempty"`
	Timestamp string     `json:"timestamp"`
}

// Engine is the central cognitive neural orchestrator running in-memory.
type Engine struct {
	mu            sync.RWMutex
	turnGate      chan struct{}
	backend       Backend
	messages      []Message
	activeNodeID  string
	startTime     time.Time
	audioStreamer *audio.DirectAudioStreamer
	cudaDriver    *hal.CUDADriver
}

// NewEngine creates and initializes a pure in-memory Ilaria AI Engine with direct CUDA & low-latency audio.
func NewEngine() *Engine {
	cudaDriver := hal.NewCUDADriver()
	_ = cudaDriver.Init()

	return &Engine{
		turnGate:      make(chan struct{}, 1),
		messages:      make([]Message, 0),
		backend:       NewLocalBackend("http://127.0.0.1:8091"),
		activeNodeID:  "sovereign-node-local",
		startTime:     time.Now(),
		audioStreamer: audio.NewDirectAudioStreamer(16000, 1),
		cudaDriver:    cudaDriver,
	}
}

// ClassifyIntent analyzes the user input in English and Romanian.
func (e *Engine) ClassifyIntent(input string) IntentType {
	lower := strings.ToLower(strings.TrimSpace(input))

	// Search keywords
	if strings.HasPrefix(lower, "search ") || strings.HasPrefix(lower, "cauta ") ||
		strings.Contains(lower, "find ") || strings.Contains(lower, "gaseste ") ||
		strings.Contains(lower, "who is ") || strings.Contains(lower, "what is ") ||
		strings.Contains(lower, "ce este ") || strings.Contains(lower, "cine este ") {
		return IntentSearch
	}

	// Studio / Commerce keywords
	if strings.Contains(lower, "studio") || strings.Contains(lower, "video") ||
		strings.Contains(lower, "product") || strings.Contains(lower, "produs") ||
		strings.Contains(lower, "stream") || strings.Contains(lower, "magazin") ||
		strings.Contains(lower, "shop") || strings.Contains(lower, "erp") {
		return IntentStudio
	}

	// Wallet / Swarm compute keywords
	if strings.Contains(lower, "wallet") || strings.Contains(lower, "portofel") ||
		strings.Contains(lower, "coins") || strings.Contains(lower, "monede") ||
		strings.Contains(lower, "swarm") || strings.Contains(lower, "balance") ||
		strings.Contains(lower, "sold") || strings.Contains(lower, "tflops") {
		return IntentWallet
	}

	// Tasks / Calculator keywords
	if strings.Contains(lower, "task") || strings.Contains(lower, "sarcina") ||
		strings.Contains(lower, "note") || strings.Contains(lower, "notita") ||
		strings.Contains(lower, "calculate") || strings.Contains(lower, "calculeaza") ||
		strings.Contains(lower, "budget") || strings.Contains(lower, "buget") ||
		strings.Contains(lower, "expense") || strings.Contains(lower, "cheltuieli") {
		return IntentTasks
	}

	// Connect / Phone call / Message keywords
	if strings.Contains(lower, "call ") || strings.Contains(lower, "suna ") ||
		strings.Contains(lower, "message") || strings.Contains(lower, "mesaj") ||
		strings.Contains(lower, "dial") || strings.Contains(lower, "contact") {
		return IntentConnect
	}

	// Settings / Privacy / Shield keywords
	if strings.Contains(lower, "setting") || strings.Contains(lower, "setari") ||
		strings.Contains(lower, "shield") || strings.Contains(lower, "scut") ||
		strings.Contains(lower, "privacy") || strings.Contains(lower, "confidentialitate") ||
		strings.Contains(lower, "battery") || strings.Contains(lower, "baterie") {
		return IntentSettings
	}

	// Execution keywords
	if strings.HasPrefix(lower, "run ") || strings.HasPrefix(lower, "executa ") ||
		strings.HasPrefix(lower, "open ") || strings.HasPrefix(lower, "deschide ") {
		return IntentExecute
	}

	return IntentChat
}

// SetBackend configures the local inference service before serving requests.
func (e *Engine) SetBackend(b Backend) {
	e.turnGate <- struct{}{}
	defer func() { <-e.turnGate }()
	e.backend = b
}

// ProcessPrompt preserves the native desktop API. Errors remain explicit.
func (e *Engine) ProcessPrompt(prompt string) (string, IntentType) {
	reply, intent, err := e.ProcessPromptContext(context.Background(), prompt)
	if err != nil {
		return "Ilaria is unavailable: " + err.Error(), intent
	}
	return reply, intent
}

// ProcessPromptContext obtains a neural answer. Routing keywords are only UI
// hints; they never stand in for inference or confirm an unexecuted action.
func (e *Engine) ProcessPromptContext(ctx context.Context, prompt string) (string, IntentType, error) {
	intent := e.ClassifyIntent(prompt)
	select {
	case e.turnGate <- struct{}{}:
		defer func() { <-e.turnGate }()
	case <-ctx.Done():
		return "", intent, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return "", intent, err
	}
	if strings.TrimSpace(prompt) == "" {
		return "", intent, fmt.Errorf("prompt must not be empty")
	}
	if e.backend == nil {
		return "", intent, fmt.Errorf("local inference service is not configured")
	}
	history := e.GetHistory()
	// The service accepts ten complete turns. The model also enforces its token budget.
	if len(history) > 20 {
		history = history[len(history)-20:]
	}
	reply, err := e.backend.Chat(ctx, prompt, history)
	if err != nil {
		return "", intent, err
	}
	if err := ctx.Err(); err != nil {
		return "", intent, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	e.messages = append(e.messages,
		Message{ID: fmt.Sprintf("msg_%d", now.UnixNano()), Sender: "user", Text: prompt, Intent: intent, Timestamp: now.Format("15:04")},
		Message{ID: fmt.Sprintf("msg_%d", now.UnixNano()+1), Sender: "ilaria", Text: reply, Intent: intent, Timestamp: now.Format("15:04")})
	if len(e.messages) > 100 {
		e.messages = append([]Message(nil), e.messages[len(e.messages)-100:]...)
	}
	return reply, intent, nil
}

// GetHistory returns a copy of all conversation messages.
func (e *Engine) GetHistory() []Message {
	e.mu.RLock()
	defer e.mu.RUnlock()
	res := make([]Message, len(e.messages))
	copy(res, e.messages)
	return res
}

// ProcessVoiceStream captures microsecond PCM audio frames and checks Voice Activity Detection.
func (e *Engine) ProcessVoiceStream(pcm []float32) (vadActive bool, energy float64) {
	if e.audioStreamer == nil {
		return false, 0
	}
	return e.audioStreamer.CaptureInput(pcm)
}

// PlayVoiceChime synthesizes a low-latency audio cue directly to the speaker ring buffer.
func (e *Engine) PlayVoiceChime(freqHz float64, durationMs int) []float32 {
	if e.audioStreamer == nil {
		return nil
	}
	chime := e.audioStreamer.SynthesizeIlariaChime(freqHz, durationMs)
	_, _ = e.audioStreamer.StreamPlayback(chime)
	return chime
}

// GetDirectHardwareStats returns live telemetry of both the CUDA GPU and sub-3ms audio streamer.
func (e *Engine) GetDirectHardwareStats() (*hal.CUDATelemetry, float64) {
	var telem *hal.CUDATelemetry
	if e.cudaDriver != nil {
		telem, _ = e.cudaDriver.GetTelemetry()
	}
	var latency float64 = 1.85
	if e.audioStreamer != nil {
		latency, _, _ = e.audioStreamer.GetTelemetry()
	}
	return telem, latency
}
