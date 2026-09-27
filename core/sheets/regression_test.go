package sheets

import "testing"

func TestFormulaDependenciesAndCycles(t *testing.T) {
	s := NewSheet("test", 10, 30)
	s.SetCell(1, 1, "100")
	if got := s.Cells[cellKey(4, 1)].Value; got != 1660 {
		t.Fatalf("stale total: %v", got)
	}
	s.SetCell(0, 26, "=SUM(B5:B5)")
	s.SetCell(1, 26, "=SUM(AA1:AA1)")
	s.SetCell(1, 1, "200")
	if got := s.Cells[cellKey(1, 26)].Value; got != 1760 {
		t.Fatalf("stale dependency: %v", got)
	}
	s.SetCell(0, 26, "=SUM(AA2:AA2)")
	if s.Cells[cellKey(0, 26)].Display != "#CYCLE!" {
		t.Fatal("cycle not detected")
	}
	s.SetCell(0, 26, "=SUM(A1:A999999999)")
	if s.Cells[cellKey(0, 26)].Display != "#REF!" {
		t.Fatal("unbounded range accepted")
	}
}
