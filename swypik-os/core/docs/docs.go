package docs

import (
	"fmt"
	"strings"
	"sync"
	"time"
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
	mu   sync.RWMutex
	docs map[string]*Document
}

// NewManager creates an initialized AI Docs manager.
func NewManager() *Manager {
	m := &Manager{
		docs: make(map[string]*Document),
	}
	m.seedDefaultDoc()
	return m
}

func (m *Manager) seedDefaultDoc() {
	content := `# SwypikOS Native Executive Report
Author: Abel Varga — Founder
Date: ` + time.Now().Format("02 January 2006") + `

## 1. Executive Summary
SwypikOS delivers a sovereign, pure-native operating environment built directly in Go and GPU shaders.
All legacy web bloatware has been permanently excised.

## 2. Key Objectives
- Sub-50ms instant boot latency.
- Memory footprint under 30MB RAM.
- Autonomous cognitive execution via Ilaria AI.
`
	doc := &Document{
		ID:        "doc_welcome",
		Title:     "SwypikOS Executive Report",
		Content:   content,
		WordCount: len(strings.Fields(content)),
		UpdatedAt: time.Now(),
	}
	m.docs[doc.ID] = doc
}

// GetDocument returns a document by ID.
func (m *Manager) GetDocument(id string) (*Document, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	doc, exists := m.docs[id]
	if !exists {
		return nil, fmt.Errorf("document not found: %s", id)
	}
	return doc, nil
}

// AppendText appends text to a document and recalculates metrics.
func (m *Manager) AppendText(id string, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	doc, exists := m.docs[id]
	if !exists {
		return fmt.Errorf("document not found: %s", id)
	}

	doc.Content += "\n" + text
	doc.WordCount = len(strings.Fields(doc.Content))
	doc.UpdatedAt = time.Now()
	return nil
}
