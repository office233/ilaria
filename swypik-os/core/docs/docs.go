package docs

import (
	"fmt"
	"sync"
	"time"
	"unicode"

	resourcepolicy "swypik-os/core/resource"
)

// Document represents an AI-assisted text document.
type Document struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	WordCount int       `json:"word_count"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Manager coordinates document editing and intelligent synthesis.
type Manager struct {
	mu               sync.RWMutex
	docs             map[string]*Document
	maxDocumentBytes int
}

// NewManager creates an initialized AI Docs manager.
func NewManager() *Manager {
	return &Manager{
		docs:             make(map[string]*Document),
		maxDocumentBytes: resourcepolicy.Default().MaxDocumentBytes,
	}
}

// CreateDocument stores caller-supplied content and returns an owned snapshot.
// A new manager never invents user documents, authors or performance claims.
func (m *Manager) CreateDocument(id, title, content string) (*Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == "" || title == "" {
		return nil, fmt.Errorf("document id and title are required")
	}
	if _, exists := m.docs[id]; exists {
		return nil, fmt.Errorf("document already exists: %s", id)
	}
	if len(content) > m.maxDocumentBytes {
		return nil, fmt.Errorf("document size limit (%d bytes) reached", m.maxDocumentBytes)
	}
	doc := &Document{
		ID:        id,
		Title:     title,
		Content:   content,
		WordCount: countWords(content),
		UpdatedAt: time.Now().UTC(),
	}
	m.docs[doc.ID] = doc
	copy := *doc
	return &copy, nil
}

// GetDocument returns an owned snapshot, not mutable manager state.
func (m *Manager) GetDocument(id string) (*Document, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	doc, exists := m.docs[id]
	if !exists {
		return nil, fmt.Errorf("document not found: %s", id)
	}
	copy := *doc
	return &copy, nil
}

// AppendText appends text to a document and recalculates metrics.
func (m *Manager) AppendText(id string, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	doc, exists := m.docs[id]
	if !exists {
		return fmt.Errorf("document not found: %s", id)
	}

	if len(text) >= m.maxDocumentBytes-len(doc.Content) {
		return fmt.Errorf("document size limit (%d bytes) reached", m.maxDocumentBytes)
	}
	doc.Content += "\n" + text
	// Append always inserts a newline, so word boundaries cannot merge across
	// the old/new content boundary. Count only the new text instead of rescanning
	// the entire resident document on every edit.
	doc.WordCount += countWords(text)
	doc.UpdatedAt = time.Now().UTC()
	return nil
}

func countWords(s string) int {
	count := 0
	inWord := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			inWord = false
			continue
		}
		if !inWord {
			count++
			inWord = true
		}
	}
	return count
}
