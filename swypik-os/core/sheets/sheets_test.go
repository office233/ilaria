package sheets

import (
	"testing"
)

func TestAISheets(t *testing.T) {
	sheet := NewSheet("Company Budget", 10, 5)

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
}
