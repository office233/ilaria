package sheets

import (
	"math"
	"strings"
	"testing"
)

func TestNewSheetDoesNotInventExpenses(t *testing.T) {
	s := NewSheet("New", 10, 2)
	if len(s.Cells) != 0 || s.GetTotal() != 0 {
		t.Fatal("new sheet contains fictitious financial data")
	}
	s.ProcessPrompt("please add Hosting 200")
	if len(s.Cells) != 0 {
		t.Fatal("a non-command prompt inserted a row")
	}
	s.ProcessPrompt("add Hosting 200")
	if s.GetTotal() != 200 {
		t.Fatal("explicit add command did not insert a row")
	}
}

func TestLiteralHashTextCannotBecomeAnEvaluationError(t *testing.T) {
	for i := 0; i < 1000; i++ {
		s := NewSheet("test", 4, 2)
		s.SetCell(0, 0, "#N/A")
		s.SetCell(1, 0, "7")
		s.SetCell(2, 0, "=SUM(A1:A2)")
		s.SetCell(3, 0, "=SUM(A3:A3)")
		if first, second := s.Cells[cellKey(2, 0)], s.Cells[cellKey(3, 0)]; first.Value != 7 || second.Value != 7 || first.Display != "7.00" || second.Display != "7.00" {
			t.Fatalf("evaluation depends on map traversal: first=%+v second=%+v", first, second)
		}
	}
}

func TestRealFormulaErrorsPropagateAndRecover(t *testing.T) {
	s := NewSheet("test", 3, 1)
	s.SetCell(0, 0, "=SUM(A1:A99)")
	s.SetCell(1, 0, "=SUM(A1:A1)")
	if got := s.Cells[cellKey(1, 0)].Display; got != "#REF!" {
		t.Fatalf("formula error was not propagated: %s", got)
	}
	s.SetCell(0, 0, "4")
	if got := s.Cells[cellKey(1, 0)].Value; got != 4 {
		t.Fatalf("stale evaluation error survived recalculation: %v", got)
	}
}

func TestTotalOrderAndColumnOverflowAreBounded(t *testing.T) {
	s := NewSheet("test", 4, int(^uint(0)>>1))
	s.SetCell(0, 0, "10000000000000000")
	s.SetCell(1, 0, "1")
	s.SetCell(2, 0, "-10000000000000000")
	want := s.GetTotal()
	for i := 0; i < 1000; i++ {
		if got := s.GetTotal(); math.Float64bits(got) != math.Float64bits(want) {
			t.Fatal("floating point total depends on map order")
		}
	}
	s.SetCell(3, 0, "=SUM("+strings.Repeat("Z", 100)+"1:A1)")
	if got := s.Cells[cellKey(3, 0)].Display; got != "#REF!" {
		t.Fatalf("overflowing column was accepted: %s", got)
	}
}
