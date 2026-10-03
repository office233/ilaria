package views

import (
	"swypik-os/config"
	"sync"
	"time"
)

// AppID identifies each of the 6 native apps.
type AppID string

const (
	AppNone         AppID = ""
	AppSearch       AppID = "search"
	AppStudio       AppID = "studio"
	AppComputeSwarm AppID = "compute-swarm"
	AppTasks        AppID = "tasks"
	AppConnect      AppID = "connect"
	AppSettings     AppID = "settings"
	AppFiles        AppID = "files"
	AppStore        AppID = "store"
	AppCyber        AppID = "cyber"
)

// AppMetadata represents an app's display card in the launcher and taskbar.
type AppMetadata struct {
	ID          AppID
	Name        string
	Category    string
	Description string
	Glyph       string
}

// NativeApps is the official registry of the sovereign applications.
var NativeApps = []AppMetadata{
	{
		ID:          AppSearch,
		Name:        "Swypik Search",
		Category:    "Sovereign Core",
		Description: "Clean, ad-free web intelligence with direct Ilaria synthesis",
		Glyph:       "Search",
	},
	{
		ID:          AppFiles,
		Name:        "Files & Folders",
		Category:    "System Explorer",
		Description: "Native filesystem navigator, directory inspector, and drive explorer",
		Glyph:       "Files",
	},
	{
		ID:          AppStudio,
		Name:        "Studio & Media",
		Category:    "Commerce & Media",
		Description: "Video commerce feed, creator reels, and live ERP dashboard",
		Glyph:       "Studio",
	},
	{
		ID:          AppComputeSwarm,
		Name:        "Compute Swarm",
		Category:    "Compute",
		Description: "Optional P2P compute contribution: revocable consent, no coins, rewards or transfers",
		Glyph:       "Connect",
	},
	{
		ID:          AppTasks,
		Name:        "Tasks & Notes",
		Category:    "Productivity",
		Description: "AI-automated ledger and budgeting; zero manual spreadsheets",
		Glyph:       "Tasks",
	},
	{
		ID:          AppConnect,
		Name:        "Swypik Connect",
		Category:    "Communications",
		Description: "Direct voice calling, VIP contacts, and encrypted messaging",
		Glyph:       "Connect",
	},
	{
		ID:          AppSettings,
		Name:        "Shield & Settings",
		Category:    "Security & System",
		Description: "Cognitive notification filtering and battery optimization",
		Glyph:       "Shield",
	},
	{
		ID:          AppStore,
		Name:        "AI App Store",
		Category:    "Sovereign Ecosystem",
		Description: "100% AI-generated native apps: Sheets AI, Docs AI, and on-demand micro-apps",
		Glyph:       "Store",
	},
	{
		ID:          AppCyber,
		Name:        "Machines & Brain",
		Category:    "Universal Control",
		Description: "Universal hardware brain: CAN bus, robotics, BCI thoughts & world model",
		Glyph:       "Cyber",
	},
}

// DesktopState coordinates the entire visible interface in memory.
type DesktopState struct {
	mu           sync.RWMutex
	ActiveApp    AppID
	SearchQuery  string
	IlariaOpen   bool
	IlariaPrompt string
	LastClockStr string

	// Conversational Omnibar State (Chat & Voice)
	omnibarInput string
	executionLog string
	voiceActive  bool
	currentPath  string
}

// NewDesktopState creates an initialized desktop state.
func NewDesktopState() *DesktopState {
	return &DesktopState{
		ActiveApp:    AppSearch, // Starts cleanly with Swypik Search
		SearchQuery:  "",
		IlariaOpen:   false,
		IlariaPrompt: "",
		LastClockStr: time.Now().Format("15:04:05"),
		omnibarInput: "",
		executionLog: "SwypikOS Native Agent Ready. Type any system command, ask Ilaria, or generate code.",
		voiceActive:  false,
		currentPath:  config.Get().WorkspaceDir,
	}
}

// SetActiveApp switches the currently focused native application.
func (s *DesktopState) SetActiveApp(id AppID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ActiveApp = id
}

// GetActiveApp retrieves the focused native app ID.
func (s *DesktopState) GetActiveApp() AppID {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ActiveApp
}

// ToggleIlaria toggles the AI assistant slide-out panel.
func (s *DesktopState) ToggleIlaria() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.IlariaOpen = !s.IlariaOpen
	return s.IlariaOpen
}

// IsIlariaOpen returns true if the assistant panel is visible.
func (s *DesktopState) IsIlariaOpen() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.IlariaOpen
}

// AppendInput appends a character to the active bottom omnibar.
func (s *DesktopState) AppendInput(ch rune) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.omnibarInput += string(ch)
}

// PopInput removes the last character from the active bottom omnibar.
func (s *DesktopState) PopInput() {
	s.mu.Lock()
	defer s.mu.Unlock()
	runes := []rune(s.omnibarInput)
	if len(runes) > 0 {
		s.omnibarInput = string(runes[:len(runes)-1])
	}
}

// ClearInput resets the omnibar input string.
func (s *DesktopState) ClearInput() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	val := s.omnibarInput
	s.omnibarInput = ""
	return val
}

// SetExecutionLog updates the system execution output panel.
func (s *DesktopState) SetExecutionLog(log string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.executionLog = log
}

// ToggleVoice flips the active microphone status.
func (s *DesktopState) ToggleVoice() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.voiceActive = !s.voiceActive
	return s.voiceActive
}

// GetOmnibarInput safely retrieves current omnibar text under read lock.
func (s *DesktopState) GetOmnibarInput() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.omnibarInput
}

// IsVoiceActive safely checks microphone state under read lock.
func (s *DesktopState) IsVoiceActive() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.voiceActive
}

// GetExecutionLog safely retrieves execution console log under read lock.
func (s *DesktopState) GetExecutionLog() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.executionLog
}

// GetCurrentPath safely retrieves working directory under read lock.
func (s *DesktopState) GetCurrentPath() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentPath
}
