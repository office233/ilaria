package sheets

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// recalculate runs while the sheet lock is held. DFS handles dependency order and cycles.
func (s *Sheet) recalculate() {
	state := make(map[string]uint8)
	var evaluate func(string) (float64, error)
	evaluate = func(key string) (float64, error) {
		cell, exists := s.Cells[key]
		if !exists {
			return 0, nil
		}
		if state[key] == 1 {
			return 0, fmt.Errorf("#CYCLE!")
		}
		if state[key] == 2 {
			if strings.HasPrefix(cell.Display, "#") {
				return 0, fmt.Errorf("%s", cell.Display)
			}
			return cell.Value, nil
		}
		state[key] = 1
		value, err := strconv.ParseFloat(cell.Raw, 64)
		cell.Display = cell.Raw
		if err == nil && !math.IsNaN(value) && !math.IsInf(value, 0) {
			cell.Value = value
			cell.Display = fmt.Sprintf("%.2f", value)
		} else if strings.HasPrefix(cell.Raw, "=") {
			value, err = s.sumFormula(cell.Raw, evaluate)
			if err != nil {
				cell.Value = 0
				cell.Display = err.Error()
			} else {
				cell.Value = value
				cell.Display = fmt.Sprintf("%.2f", value)
			}
		} else {
			cell.Value = 0
			err = nil
		}
		state[key] = 2
		s.Cells[key] = cell
		return cell.Value, err
	}
	for key := range s.Cells {
		_, _ = evaluate(key)
	}
}

func (s *Sheet) sumFormula(raw string, evaluate func(string) (float64, error)) (float64, error) {
	formula := strings.ToUpper(strings.TrimSpace(raw))
	invalid := fmt.Errorf("#REF!")
	if !strings.HasPrefix(formula, "=SUM(") || !strings.HasSuffix(formula, ")") {
		return 0, fmt.Errorf("#FORMULA!")
	}
	refs := strings.Split(formula[5:len(formula)-1], ":")
	if len(refs) != 2 {
		return 0, invalid
	}
	parse := func(ref string) (int, int, error) {
		ref = strings.TrimSpace(ref)
		col, i := 0, 0
		for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
			col = col*26 + int(ref[i]-'A') + 1
			i++
			if col > s.Cols {
				return 0, 0, invalid
			}
		}
		row, err := strconv.Atoi(ref[i:])
		if err != nil || col == 0 || row <= 0 || row > s.Rows {
			return 0, 0, invalid
		}
		return row - 1, col - 1, nil
	}
	r1, c1, err := parse(refs[0])
	if err != nil {
		return 0, err
	}
	r2, c2, err := parse(refs[1])
	if err != nil {
		return 0, err
	}
	if r1 > r2 {
		r1, r2 = r2, r1
	}
	if c1 > c2 {
		c1, c2 = c2, c1
	}
	var sum float64
	for r := r1; r <= r2; r++ {
		for c := c1; c <= c2; c++ {
			value, err := evaluate(cellKey(r, c))
			if err != nil {
				return 0, err
			}
			sum += value
		}
	}
	if math.IsInf(sum, 0) || math.IsNaN(sum) {
		return 0, fmt.Errorf("#NUM!")
	}
	return sum, nil
}
