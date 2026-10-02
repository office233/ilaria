package sheets

import (
	"strings"
	"testing"
)

func budgetFixture() *Sheet {
	s := NewSheet("Company Budget", 10, 30)
	for row, values := range [][]string{
		{"Category", "Amount"}, {"Cloud Servers", "850.00"},
		{"Office Utilities", "320.00"}, {"Hardware Components", "1240.00"},
		{"Total", "=SUM(B2:B4)"},
	} {
		for col, value := range values {
			s.SetCell(row, col, value)
		}
	}
	return s
}

func TestAISheets(t *testing.T) {
	sheet := budgetFixture()

	total := sheet.GetTotal()
	if total != 2410.00 {
		t.Errorf("Expected initial total 2410.00, got %.2f", total)
	}

	res := sheet.ProcessPrompt("add Marketing 500")
	if sheet.GetTotal() != 2910.00 {
		t.Errorf("Expected updated total 2910.00, got %.2f (response: %s)", sheet.GetTotal(), res)
	}

	// Verify no deadlock when hitting line 134
	syncRes := sheet.ProcessPrompt("sync status")
	if len(syncRes) == 0 {
		t.Error("expected non-empty response from sync status")
	}
	if strings.Contains(strings.ToLower(syncRes), "synchronized") {
		t.Fatalf("status-only prompt overclaimed synchronization: %q", syncRes)
	}
}
