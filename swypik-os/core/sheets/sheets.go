package sheets

import (
	"fmt"
	"math"
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
	s := &Sheet{
		Title: title,
		Cells: make(map[string]Cell),
		Rows:  rows,
		Cols:  cols,
	}
	s.seedDefaultBudget()
	return s
}

func (s *Sheet) seedDefaultBudget() {
	// Seed realistic starter expenses
	s.SetCell(0, 0, "Category")
	s.SetCell(0, 1, "Amount (RON)")
	s.SetCell(1, 0, "Cloud Servers")
	s.SetCell(1, 1, "850.00")
	s.SetCell(2, 0, "Office Utilities")
	s.SetCell(2, 1, "320.00")
	s.SetCell(3, 0, "Hardware Components")
	s.SetCell(3, 1, "1240.00")
	s.SetCell(4, 0, "Total")
	s.SetCell(4, 1, "=SUM(B2:B4)")
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
	for _, c := range s.Cells {
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

	lower := strings.ToLower(prompt)
	if strings.Contains(lower, "add ") || strings.Contains(lower, "adauga ") {
		// Example: "add Hosting 200"
		parts := strings.Fields(prompt)
		if len(parts) >= 3 {
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
				return fmt.Sprintf("Added item '%s' with amount %.2f RON to AI Sheet.", name, val)
			}
		}
	}

	return fmt.Sprintf("AI Sheet '%s' synchronized. Total calculated: %.2f RON across active rows.", s.Title, s.getTotalLocked())
}
