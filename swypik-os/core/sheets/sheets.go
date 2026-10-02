package sheets

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Cell represents a single spreadsheet cell with a raw value or formula.
type Cell struct {
	Row     int     `json:"row"`
	Col     int     `json:"col"`
	Raw     string  `json:"raw"`
	Value   float64 `json:"value"`
	Display string  `json:"display"`
}

// Sheet is an in-memory intelligent grid powered by Ilaria AI.
type Sheet struct {
	mu    sync.RWMutex
	Title string
	Cells map[string]Cell
	Rows  int
	Cols  int
}

// NewSheet creates an initialized AI Sheet.
func NewSheet(title string, rows, cols int) *Sheet {
	return &Sheet{
		Title: title,
		Cells: make(map[string]Cell),
		Rows:  rows,
		Cols:  cols,
	}
}

func cellKey(row, col int) string {
	return fmt.Sprintf("%d:%d", row, col)
}

// SetCell updates the content of a cell and recalculates dependencies.
func (s *Sheet) SetCell(row, col int, raw string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if row < 0 || col < 0 || row >= s.Rows || col >= s.Cols {
		return
	}
	s.Cells[cellKey(row, col)] = Cell{Row: row, Col: col, Raw: strings.TrimSpace(raw)}
	s.recalculate()
}

func (s *Sheet) getTotalLocked() float64 {
	var total float64 = 0
	keys := make([]string, 0, len(s.Cells))
	for key := range s.Cells {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		c := s.Cells[key]
		if !strings.HasPrefix(c.Raw, "=") {
			total += c.Value
		}
	}
	return total
}

// GetTotal calculates the total sum of numerical entries.
func (s *Sheet) GetTotal() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getTotalLocked()
}

// ProcessPrompt applies spoken/natural language commands to the spreadsheet.
func (s *Sheet) ProcessPrompt(prompt string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	parts := strings.Fields(prompt)
	if len(parts) >= 3 && (strings.EqualFold(parts[0], "add") || strings.EqualFold(parts[0], "adauga")) {
		// Example: "add Hosting 200"
		name := strings.Join(parts[1:len(parts)-1], " ")
		amountStr := parts[len(parts)-1]
		if val, err := strconv.ParseFloat(amountStr, 64); err == nil && !math.IsNaN(val) && !math.IsInf(val, 0) {
			nextRow := 0
			for _, c := range s.Cells {
				if c.Row >= nextRow {
					nextRow = c.Row + 1
				}
			}
			if nextRow >= s.Rows || s.Cols < 2 {
				return "Sheet is full."
			}
			s.Cells[cellKey(nextRow, 0)] = Cell{Row: nextRow, Col: 0, Raw: name, Display: name}
			s.Cells[cellKey(nextRow, 1)] = Cell{Row: nextRow, Col: 1, Raw: amountStr, Value: val, Display: fmt.Sprintf("%.2f", val)}
			s.recalculate()
			return fmt.Sprintf("Added item '%s' with amount %.2f to AI Sheet.", name, val)
		}
	}

	return fmt.Sprintf("Sheet '%s' status: total %.2f across active rows. No remote synchronization was performed.", s.Title, s.getTotalLocked())
}
