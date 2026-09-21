package biomed

import (
	"strings"
	"testing"
)

// Review findings 2026-09-21 (verified on live labels): units per kilogram,
// unrelated percentages, decimal points in quotes, renal clearance, ranges.

func TestExtractPK_RejectsPerKilogramUnits(t *testing.T) {
	pk := ExtractPK("Naproxen has a volume of distribution of 0.16 L/kg. Total plasma clearance was 0.13 mL/min/kg.")
	if pk.VdLiters != nil {
		t.Fatalf("0.16 L/kg is not an absolute volume: got %+v", pk.VdLiters)
	}
	if pk.ClearanceLPerHour != nil {
		t.Fatalf("mL/min/kg is not an absolute clearance: got %+v", pk.ClearanceLPerHour)
	}
}

func TestExtractPK_ProteinBindingNeedsProteinContext(t *testing.T) {
	pk := ExtractPK("The 90% CI for Cmax exceeded the upper boundary of the bioequivalence range.")
	if pk.ProteinBoundFraction != nil {
		t.Fatalf("'boundary' near a percentage is not protein binding: got %+v", pk.ProteinBoundFraction)
	}
	pk = ExtractPK("Naproxen is >99% albumin-bound at therapeutic concentrations.")
	if pk.ProteinBoundFraction == nil || pk.ProteinBoundFraction.Value != 0.99 {
		t.Fatalf("albumin-bound 99%% expected: got %+v", pk.ProteinBoundFraction)
	}
	pk = ExtractPK("Lacosamide is less than 15% bound to plasma proteins.")
	if pk.ProteinBoundFraction == nil || pk.ProteinBoundFraction.Value != 0.15 {
		t.Fatalf("bound to plasma proteins 15%% expected: got %+v", pk.ProteinBoundFraction)
	}
}

func TestExtractPK_RenalFractionNeedsExcretionContext(t *testing.T) {
	pk := ExtractPK("Plasma protein binding of varenicline is low (≤20%) and independent of both age and renal function.")
	if pk.RenalFraction != nil {
		t.Fatalf("a percentage near 'renal function' is not renal excretion: got %+v", pk.RenalFraction)
	}
	if pk.ProteinBoundFraction == nil || pk.ProteinBoundFraction.Value != 0.20 {
		t.Fatalf("protein binding 20%% expected: got %+v", pk.ProteinBoundFraction)
	}
	pk = ExtractPK("Approximately 60% of the dose was recovered in urine and 30% in feces.")
	if pk.RenalFraction == nil || pk.RenalFraction.Value != 0.60 {
		t.Fatalf("urine fraction 60%% expected: got %+v", pk.RenalFraction)
	}
	pk = ExtractPK("Radioactivity was recovered in feces (60%) and urine (30%).")
	if pk.RenalFraction == nil || pk.RenalFraction.Value != 0.30 {
		t.Fatalf("urine fraction 30%% expected: got %+v", pk.RenalFraction)
	}
}

func TestExtractPK_QuoteContainsTheNumberDespiteDecimalPoint(t *testing.T) {
	pk := ExtractPK("Tocilizumab has a terminal half-life of approximately 21.5 hours at steady state. Next sentence.")
	if pk.HalfLifeHours == nil || pk.HalfLifeHours.Value != 21.5 {
		t.Fatalf("got %+v", pk.HalfLifeHours)
	}
	if !strings.Contains(pk.HalfLifeHours.Quote, "21.5 hours") || strings.Contains(pk.HalfLifeHours.Quote, "Next sentence") {
		t.Fatalf("quote must be the sentence containing the value: %q", pk.HalfLifeHours.Quote)
	}
}

func TestExtractPK_SkipsRenalClearanceAndPrefersSystemic(t *testing.T) {
	pk := ExtractPK("Renal clearance (18.8 L/h) exceeds the glomerular filtration rate. Apparent total clearance was 25.3 L/h.")
	if pk.ClearanceLPerHour == nil || pk.ClearanceLPerHour.Value != 25.3 {
		t.Fatalf("systemic clearance expected, got %+v", pk.ClearanceLPerHour)
	}
	if pk := ExtractPK("Renal clearance is 250 to 450 mL/minute."); pk.ClearanceLPerHour != nil {
		t.Fatalf("renal-only clearance must not be reported as total clearance: %+v", pk.ClearanceLPerHour)
	}
}

func TestExtractPK_PrefersHealthyOverImpairmentSentence(t *testing.T) {
	pk := ExtractPK("In patients with mild-to-moderate hepatic impairment the mean half-life is increased to 11.6 hours. In healthy subjects the elimination half-life is 3.8 hours.")
	if pk.HalfLifeHours == nil || pk.HalfLifeHours.Value != 3.8 {
		t.Fatalf("healthy-subject value expected, got %+v", pk.HalfLifeHours)
	}
}
