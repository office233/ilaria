package biomed

import (
	"errors"
	"math"
	"testing"
)

func pkFor(halfLife, vd float64) PKParameters {
	return PKParameters{
		HalfLifeHours: &Measured{Value: halfLife, Unit: "h", Quote: "test"},
		VdLiters:      &Measured{Value: vd, Unit: "L", Quote: "test"},
	}
}

func TestSimulate_SingleDoseMatchesAnalyticDecay(t *testing.T) {
	// k = ln2 / t½ ; choose t½ = ln2 so k = 1 and C(t) = (D/Vd)·e^{-t}.
	sim, err := Simulate(pkFor(math.Ln2, 10), DoseRegimen{DoseMg: 100, IntervalHours: 1000, DurationHours: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(sim.Points) == 0 || sim.Points[0].TimeHours != 0 || math.Abs(sim.Points[0].ConcMgPerL-10) > 1e-9 {
		t.Fatalf("C(0) = %+v, want 10", sim.Points[0])
	}
	var at1 *PKPoint
	for i := range sim.Points {
		if math.Abs(sim.Points[i].TimeHours-1) < 1e-9 {
			at1 = &sim.Points[i]
		}
	}
	if at1 == nil || math.Abs(at1.ConcMgPerL-10*math.Exp(-1)) > 1e-6 {
		t.Fatalf("C(1) = %+v, want %.6f", at1, 10*math.Exp(-1))
	}
}

func TestSimulate_SteadyStateMatchesAnalyticFormula(t *testing.T) {
	halfLife, vd, dose, tau := 48.0, 1400.0, 250.0, 24.0
	sim, err := Simulate(pkFor(halfLife, vd), DoseRegimen{DoseMg: dose, IntervalHours: tau, DurationHours: 30 * 24})
	if err != nil {
		t.Fatal(err)
	}
	k := math.Ln2 / halfLife
	wantCmax := (dose / vd) / (1 - math.Exp(-k*tau))
	wantCmin := wantCmax * math.Exp(-k*tau)
	wantAUC := dose / (vd * k)
	if math.Abs(sim.CmaxSS-wantCmax) > 1e-9 || math.Abs(sim.CminSS-wantCmin) > 1e-9 || math.Abs(sim.AUCPerInterval-wantAUC) > 1e-9 {
		t.Fatalf("SS: got cmax %.6f cmin %.6f auc %.6f, want %.6f %.6f %.6f", sim.CmaxSS, sim.CminSS, sim.AUCPerInterval, wantCmax, wantCmin, wantAUC)
	}
	// After 30 days (15 half-lives) the simulated trough must be within 0.1% of the analytic steady state.
	last := sim.Points[len(sim.Points)-1]
	if math.Abs(last.ConcMgPerL-wantCmin)/wantCmin > 1e-3 {
		t.Fatalf("simulated trough %.6f vs analytic %.6f", last.ConcMgPerL, wantCmin)
	}
}

func TestSimulate_BioavailabilityScalesDose(t *testing.T) {
	full, _ := Simulate(pkFor(10, 50), DoseRegimen{DoseMg: 100, IntervalHours: 12, DurationHours: 12})
	half, _ := Simulate(pkFor(10, 50), DoseRegimen{DoseMg: 100, IntervalHours: 12, DurationHours: 12, Bioavailability: 0.5})
	if math.Abs(half.CmaxSS*2-full.CmaxSS) > 1e-9 {
		t.Fatalf("F=0.5 must halve exposure: %.6f vs %.6f", half.CmaxSS, full.CmaxSS)
	}
}

func TestSimulate_MissingParametersIsErrInsufficientPK(t *testing.T) {
	_, err := Simulate(PKParameters{VdLiters: &Measured{Value: 10}}, DoseRegimen{DoseMg: 1, IntervalHours: 1, DurationHours: 1})
	if !errors.Is(err, ErrInsufficientPK) {
		t.Fatalf("missing half-life: err = %v", err)
	}
	_, err = Simulate(PKParameters{HalfLifeHours: &Measured{Value: 10}}, DoseRegimen{DoseMg: 1, IntervalHours: 1, DurationHours: 1})
	if !errors.Is(err, ErrInsufficientPK) {
		t.Fatalf("missing Vd: err = %v", err)
	}
	_, err = Simulate(pkFor(10, 10), DoseRegimen{DoseMg: 0, IntervalHours: 1, DurationHours: 1})
	if err == nil {
		t.Fatal("zero dose must be rejected")
	}
}
