package appstore

import (
	"fmt"
	"strings"
	"sync"
)

// AppPackage represents a sovereign, native AI-driven application.
type AppPackage struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Version     string  `json:"version"`
	SizeMB      float64 `json:"size_mb"`
	Description string  `json:"description"`
	AIDriven    bool    `json:"ai_driven"`
	Installed   bool    `json:"installed"`
	Platform    string  `json:"platform"` // "universal", "desktop", "mobile"
}

// Store coordinates sovereign app distribution and on-demand AI app generation.
type Store struct {
	mu   sync.RWMutex
	apps map[string]*AppPackage
}

// NewStore initializes the sovereign AI App Store catalog.
func NewStore() *Store {
	s := &Store{
		apps: make(map[string]*AppPackage),
	}
	s.seedDefaultApps()
	return s
}

func (s *Store) seedDefaultApps() {
	defaultApps := []*AppPackage{
		{
			ID:          "app.sheets.ai",
			Name:        "Swypik Sheets AI",
			Category:    "Productivity",
			Version:     "2.4.0",
			SizeMB:      3.2,
			Description: "Intelligent reactive grid with voice-prompted formula synthesis and financial forecasting.",
			AIDriven:    true,
			Installed:   true,
			Platform:    "universal",
		},
		{
			ID:          "app.docs.ai",
			Name:        "Swypik Docs AI",
			Category:    "Productivity",
			Version:     "1.9.0",
			SizeMB:      2.8,
			Description: "Autonomous document writer, executive summarizer, and markdown-to-PDF compiler.",
			AIDriven:    true,
			Installed:   true,
			Platform:    "universal",
		},
		{
			ID:          "app.coder.studio",
			Name:        "Swypik Coder Studio",
			Category:    "Developer Tools",
			Version:     "3.1.0",
			SizeMB:      5.4,
			Description: "Agentic coding environment (Claude Code style) with direct native terminal execution.",
			AIDriven:    true,
			Installed:   true,
			Platform:    "universal",
		},
		{
			ID:          "app.swarm.compute",
			Name:        "Swypik Swarm Compute",
			Category:    "Finance & Compute",
			Version:     "4.0.1",
			SizeMB:      2.1,
			Description: "Background P2P mesh compute daemon monetizing idle GPU/CPU cycles into SWP coin rewards.",
			AIDriven:    true,
			Installed:   true,
			Platform:    "universal",
		},
		{
			ID:          "app.search.shield",
			Name:        "Swypik Sovereign Search",
			Category:    "Internet & Privacy",
			Version:     "2.0.0",
			SizeMB:      1.5,
			Description: "Zero-tracking, ad-free private web synthesizer replacing Google entirely.",
			AIDriven:    true,
			Installed:   true,
			Platform:    "universal",
		},
		{
			ID:          "app.connect.mesh",
			Name:        "Swypik P2P Connect",
			Category:    "Communication",
			Version:     "1.5.0",
			SizeMB:      3.0,
			Description: "End-to-end encrypted direct peer-to-peer chat, voice, and instant file sync between PC and Mobile.",
			AIDriven:    true,
			Installed:   false,
			Platform:    "universal",
		},
		{
			ID:          "app.media.studio",
			Name:        "Swypik Neural Studio",
			Category:    "Creative",
			Version:     "1.2.0",
			SizeMB:      6.8,
			Description: "Instant AI visual design, image remastering, and layout generation.",
			AIDriven:    true,
			Installed:   false,
			Platform:    "universal",
		},
	}

	for _, app := range defaultApps {
		s.apps[app.ID] = app
	}
}

// ListApps returns all catalog applications.
func (s *Store) ListApps() []*AppPackage {
	s.mu.RLock()
	defer s.mu.RUnlock()

	list := make([]*AppPackage, 0, len(s.apps))
	for _, app := range s.apps {
		list = append(list, app)
	}
	return list
}

// InstallApp marks an app as installed.
func (s *Store) InstallApp(id string) (*AppPackage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	app, exists := s.apps[id]
	if !exists {
		return nil, fmt.Errorf("app not found: %s", id)
	}

	app.Installed = true
	return app, nil
}

// GenerateOnDemand creates a new custom micro-app synthesized by Ilaria AI.
func (s *Store) GenerateOnDemand(name, description, category string) *AppPackage {
	s.mu.Lock()
	defer s.mu.Unlock()

	slug := strings.ToLower(strings.ReplaceAll(name, " ", "."))
	id := fmt.Sprintf("custom.ai.%s", slug)

	app := &AppPackage{
		ID:          id,
		Name:        name,
		Category:    category,
		Version:     "1.0.0-ai",
		SizeMB:      1.2,
		Description: description,
		AIDriven:    true,
		Installed:   true,
		Platform:    "universal",
	}

	s.apps[id] = app
	return app
}
