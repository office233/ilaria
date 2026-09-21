package biomed

import (
	"context"
	"math"
	"testing"
)

func TestExtractPK_GefitinibLabel(t *testing.T) {
	c := openfdaClient(t)
	l, err := c.Label(context.Background(), "gefitinib")
	if err != nil {
		t.Fatal(err)
	}
	pk := ExtractPK(l.Sections["pharmacokinetics"])
	if pk.HalfLifeHours == nil || pk.HalfLifeHours.Value != 48 {
		t.Fatalf("half-life = %+v, want 48 h", pk.HalfLifeHours)
	}
	if pk.HalfLifeHours.Quote == "" || pk.HalfLifeHours.Unit != "h" {
		t.Fatalf("half-life provenance incomplete: %+v", pk.HalfLifeHours)
	}
	if pk.VdLiters == nil || pk.VdLiters.Value != 1400 {
		t.Fatalf("Vd = %+v, want 1400 L", pk.VdLiters)
	}
	if pk.RenalFraction == nil || pk.RenalFraction.Value >= 0.05 {
		t.Fatalf("renal fraction = %+v, want < 0.05 (\"less than 4%%\")", pk.RenalFraction)
	}
	if pk.ProteinBoundFraction == nil || pk.ProteinBoundFraction.Value < 0.85 {
		t.Fatalf("protein binding = %+v, want about 0.90 (label: 90%%)", pk.ProteinBoundFraction)
	}
}

func TestExtractPK_UnitsAreNormalizedToHours(t *testing.T) {
	pk := ExtractPK("The terminal elimination half-life was approximately 2 days in healthy adults.")
	if pk.HalfLifeHours == nil || pk.HalfLifeHours.Value != 48 {
		t.Fatalf("got %+v", pk.HalfLifeHours)
	}
	pk = ExtractPK("Mean half-life of 30 minutes.")
	if pk.HalfLifeHours == nil || math.Abs(pk.HalfLifeHours.Value-0.5) > 1e-9 {
		t.Fatalf("got %+v", pk.HalfLifeHours)
	}
}

func TestExtractPK_ClearanceUnitsNormalizedToLPerHour(t *testing.T) {
	pk := ExtractPK("Apparent oral clearance was 600 mL/min in adults.")
	if pk.ClearanceLPerHour == nil || math.Abs(pk.ClearanceLPerHour.Value-36) > 1e-9 {
		t.Fatalf("got %+v", pk.ClearanceLPerHour)
	}
}

func TestExtractPK_NoNumbersMeansNil(t *testing.T) {
	pk := ExtractPK("There is no pharmacokinetic information available for this product.")
	if pk.HalfLifeHours != nil || pk.VdLiters != nil || pk.ClearanceLPerHour != nil || pk.ProteinBoundFraction != nil || pk.RenalFraction != nil {
		t.Fatalf("expected all nil, got %+v", pk)
	}
	if pk := ExtractPK(""); pk.HalfLifeHours != nil {
		t.Fatalf("empty text must yield nil, got %+v", pk)
	}
}
