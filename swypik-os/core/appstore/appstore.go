package appstore

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	resourcepolicy "swypik-os/core/resource"
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
	mu      sync.RWMutex
	apps    map[string]*AppPackage
	maxApps int
}

// NewStore initializes the sovereign AI App Store catalog.
func NewStore() *Store {
	return &Store{
		apps:    make(map[string]*AppPackage),
		maxApps: resourcepolicy.Default().MaxAppCatalogEntries,
	}
}

// RegisterCatalogEntry owns explicitly supplied metadata. It cannot establish
// installed state, and duplicate IDs never overwrite an existing entry.
func (s *Store) RegisterCatalogEntry(entry AppPackage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(entry.ID) == "" || strings.TrimSpace(entry.Name) == "" ||
		entry.Installed || entry.SizeMB < 0 || math.IsNaN(entry.SizeMB) || math.IsInf(entry.SizeMB, 0) {
		return fmt.Errorf("invalid or unverified catalog entry")
	}
	if _, exists := s.apps[entry.ID]; exists {
		return fmt.Errorf("catalog entry already exists: %s", entry.ID)
	}
	if len(s.apps) >= s.maxApps {
		return fmt.Errorf("catalog entry limit reached")
	}
	s.apps[entry.ID] = &entry
	return nil
}

// ListApps returns all catalog applications.
func (s *Store) ListApps() []*AppPackage {
	s.mu.RLock()
	defer s.mu.RUnlock()

	list := make([]*AppPackage, 0, len(s.apps))
	for _, app := range s.apps {
		copy := *app
		list = append(list, &copy)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}

// InstallApp fails closed until the store owns a real installation transport.
func (s *Store) InstallApp(id string) (*AppPackage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	app, exists := s.apps[id]
	if !exists {
		return nil, fmt.Errorf("app not found: %s", id)
	}
	copy := *app
	return &copy, fmt.Errorf("app installation is unavailable: no installation transport configured")
}

// GenerateOnDemand creates a bounded catalog draft only. No code is generated,
// installed or executed by this package.
func (s *Store) GenerateOnDemand(name, description, category string) *AppPackage {
	s.mu.Lock()
	defer s.mu.Unlock()

	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	slug := strings.ToLower(strings.Join(strings.Fields(name), "."))
	id := fmt.Sprintf("custom.ai.%s", slug)
	if existing, exists := s.apps[id]; exists {
		copy := *existing
		return &copy
	}
	if len(s.apps) >= s.maxApps {
		return nil
	}

	app := &AppPackage{
		ID:          id,
		Name:        name,
		Category:    category,
		Version:     "draft",
		SizeMB:      0,
		Description: description,
		AIDriven:    true,
		Installed:   false,
		Platform:    "universal",
	}

	s.apps[id] = app
	copy := *app
	return &copy
}
