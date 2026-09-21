package biomed

import (
	"fmt"
	"math"
)

// pkpd.go — one-compartment pharmacokinetic model with first-order
// elimination and repeated dosing by superposition.
//
//   k        = ln 2 / t½
//   C(t)     = Σ_{doses i, t_i < t or t_i == t}  F·D/Vd · exp(-k·(t - t_i))
//   Cmax,ss  = (F·D/Vd) / (1 - e^{-k·τ})        Cmin,ss = Cmax,ss · e^{-k·τ}
//   AUC_τ,ss = F·D / (Vd·k)
//
// Absorption is treated as instantaneous (bolus-like). That is a stated
// simplification, not a fitted parameter: the numbers describe exposure
// shape under the label's half-life and volume of distribution, and the
// caller must present them as a model, never as a measured level.

// DoseRegimen describes repeated dosing.
type DoseRegimen struct {
	DoseMg          float64 `json:"dose_mg"`
	IntervalHours   float64 `json:"interval_hours"`
	DurationHours   float64 `json:"duration_hours"`
	Bioavailability float64 `json:"bioavailability,omitempty"` // 0 < F <= 1; 0 means 1
}

// PKPoint is one concentration sample.
type PKPoint struct {
	TimeHours  float64 `json:"t_h"`
	ConcMgPerL float64 `json:"c_mg_per_l"`
}

// PKSimulation is the model output.
type PKSimulation struct {
	Points         []PKPoint    `json:"points"`
	CmaxSS         float64      `json:"cmax_ss_mg_per_l"`
	CminSS         float64      `json:"cmin_ss_mg_per_l"`
	AUCPerInterval float64      `json:"auc_tau_ss_mg_h_per_l"`
	HalfLifeHours  float64      `json:"half_life_hours"`
	VdLiters       float64      `json:"vd_liters"`
	Params         PKParameters `json:"params"`
	Regimen        DoseRegimen  `json:"regimen"`
}

const simStepHours = 0.25

// Simulate runs the model. It needs the label's half-life and volume of
// distribution; otherwise ErrInsufficientPK.
func Simulate(p PKParameters, r DoseRegimen) (PKSimulation, error) {
	if p.HalfLifeHours == nil || p.HalfLifeHours.Value <= 0 {
		return PKSimulation{}, fmt.Errorf("half-life not stated: %w", ErrInsufficientPK)
	}
	if p.VdLiters == nil || p.VdLiters.Value <= 0 {
		return PKSimulation{}, fmt.Errorf("volume of distribution not stated: %w", ErrInsufficientPK)
	}
	if r.DoseMg <= 0 || r.IntervalHours <= 0 || r.DurationHours <= 0 {
		return PKSimulation{}, fmt.Errorf("pkpd: dose, interval and duration must be positive (got %+v)", r)
	}
	f := r.Bioavailability
	if f <= 0 || f > 1 {
		f = 1
	}
	t12, vd := p.HalfLifeHours.Value, p.VdLiters.Value
	k := math.Ln2 / t12
	unit := f * r.DoseMg / vd // concentration jump per dose

	// dose times: 0, τ, 2τ, ... strictly before DurationHours, so the final
	// sample is a trough (just before the next dose).
	var doses []float64
	for t := 0.0; t < r.DurationHours; t += r.IntervalHours {
		doses = append(doses, t)
	}

	n := int(math.Floor(r.DurationHours/simStepHours)) + 1
	points := make([]PKPoint, 0, n)
	for i := 0; i < n; i++ {
		t := float64(i) * simStepHours
		if t > r.DurationHours {
			break
		}
		c := 0.0
		for _, td := range doses {
			if td <= t {
				c += unit * math.Exp(-k*(t-td))
			}
		}
		points = append(points, PKPoint{TimeHours: t, ConcMgPerL: c})
	}
	// ensure the end of the window is sampled exactly
	if last := points[len(points)-1]; last.TimeHours < r.DurationHours {
		c := 0.0
		for _, td := range doses {
			if td <= r.DurationHours {
				c += unit * math.Exp(-k*(r.DurationHours-td))
			}
		}
		points = append(points, PKPoint{TimeHours: r.DurationHours, ConcMgPerL: c})
	}

	acc := 1 - math.Exp(-k*r.IntervalHours)
	cmax := unit / acc
	return PKSimulation{
		Points:         points,
		CmaxSS:         cmax,
		CminSS:         cmax * math.Exp(-k*r.IntervalHours),
		AUCPerInterval: f * r.DoseMg / (vd * k),
		HalfLifeHours:  t12,
		VdLiters:       vd,
		Params:         p,
		Regimen:        r,
	}, nil
}
