package biomed

import (
	"regexp"
	"strconv"
	"strings"
)

// pk_extract.go pulls pharmacokinetic parameters out of the free-text
// "Pharmacokinetics" section of an FDA label. Every value keeps the sentence
// it was taken from; anything the text does not state stays nil.
//
// The regexes are deliberately narrow: a parameter keyword followed, within
// the same sentence, by a number and a unit. Units are normalized to
// hours, litres, L/h and fractions (0..1).

// Measured is a number with its unit and the sentence that stated it.
type Measured struct {
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
	Quote string  `json:"quote"`
}

// PKParameters are the extracted values. nil = not stated in the label.
type PKParameters struct {
	HalfLifeHours        *Measured `json:"half_life_hours,omitempty"`
	VdLiters             *Measured `json:"vd_liters,omitempty"`
	ClearanceLPerHour    *Measured `json:"clearance_l_per_hour,omitempty"`
	ProteinBoundFraction *Measured `json:"protein_bound_fraction,omitempty"`
	RenalFraction        *Measured `json:"renal_fraction,omitempty"`
}

// numberUnit matches "48 hours", "1400 L", "600 mL/min", "90%".
const num = `(\d+(?:[.,]\d+)?)`

var (
	reHalfLife  = regexp.MustCompile(`(?i)half-?\s?li(?:fe|ves)[^.;]{0,120}?` + num + `\s*(hours?|hrs?|h\b|days?|minutes?|min\b)`)
	reVd        = regexp.MustCompile(`(?i)volume of distribution[^.;]{0,80}?` + num + `\s*(liters?|litres?|L\b)`)
	reClearance = regexp.MustCompile(`(?i)clearance[^.;]{0,80}?` + num + `\s*(L/h(?:r|our)?|mL/min|ml/min|L/min)`)
	reBindingA  = regexp.MustCompile(`(?i)(?:bound|binding)[^.;]{0,140}?` + num + `\s*%`)
	reBindingB  = regexp.MustCompile(`(?i)` + num + `\s*%[^.;]{0,60}?(?:bound|binding)`)
	reRenalA    = regexp.MustCompile(`(?i)(?:urine|renal|kidney)[^.;]{0,100}?(?:less than|<|approximately|about|~)?\s*` + num + `\s*%`)
	reRenalB    = regexp.MustCompile(`(?i)` + num + `\s*%[^.;]{0,100}?(?:in (?:the )?urine|renal(?:ly)?|kidney)`)
)

// ExtractPK parses a pharmacokinetics section. Empty or number-free text
// yields an all-nil result.
func ExtractPK(text string) PKParameters {
	var pk PKParameters
	if strings.TrimSpace(text) == "" {
		return pk
	}
	if m := reHalfLife.FindStringSubmatchIndex(text); m != nil {
		v := parseNum(text[m[2]:m[3]])
		unit := strings.ToLower(text[m[4]:m[5]])
		switch {
		case strings.HasPrefix(unit, "day"):
			v *= 24
		case strings.HasPrefix(unit, "min"):
			v /= 60
		}
		pk.HalfLifeHours = &Measured{Value: v, Unit: "h", Quote: sentenceAround(text, m[0])}
	}
	if m := reVd.FindStringSubmatchIndex(text); m != nil {
		pk.VdLiters = &Measured{Value: parseNum(text[m[2]:m[3]]), Unit: "L", Quote: sentenceAround(text, m[0])}
	}
	if m := findDrugClearance(text); m != nil {
		v := parseNum(text[m[2]:m[3]])
		unit := strings.ToLower(text[m[4]:m[5]])
		switch {
		case strings.HasPrefix(unit, "ml/min"):
			v = v * 60 / 1000
		case strings.HasPrefix(unit, "l/min"):
			v *= 60
		}
		pk.ClearanceLPerHour = &Measured{Value: v, Unit: "L/h", Quote: sentenceAround(text, m[0])}
	}
	if m := reBindingA.FindStringSubmatchIndex(text); m != nil {
		pk.ProteinBoundFraction = &Measured{Value: parseNum(text[m[2]:m[3]]) / 100, Unit: "fraction", Quote: sentenceAround(text, m[0])}
	} else if m := reBindingB.FindStringSubmatchIndex(text); m != nil {
		pk.ProteinBoundFraction = &Measured{Value: parseNum(text[m[2]:m[3]]) / 100, Unit: "fraction", Quote: sentenceAround(text, m[0])}
	}
	if m := reRenalA.FindStringSubmatchIndex(text); m != nil {
		pk.RenalFraction = &Measured{Value: parseNum(text[m[2]:m[3]]) / 100, Unit: "fraction", Quote: sentenceAround(text, m[0])}
	} else if m := reRenalB.FindStringSubmatchIndex(text); m != nil {
		pk.RenalFraction = &Measured{Value: parseNum(text[m[2]:m[3]]) / 100, Unit: "fraction", Quote: sentenceAround(text, m[0])}
	}
	return pk
}

func parseNum(s string) float64 {
	v, _ := strconv.ParseFloat(strings.ReplaceAll(s, ",", "."), 64)
	return v
}

// sentenceAround returns the sentence containing byte offset pos.
func sentenceAround(text string, pos int) string {
	start := strings.LastIndexAny(text[:pos], ".;\n")
	if start < 0 {
		start = 0
	} else {
		start++
	}
	end := strings.IndexAny(text[pos:], ".;\n")
	if end < 0 {
		end = len(text)
	} else {
		end += pos + 1
	}
	s := strings.TrimSpace(text[start:end])
	if len(s) > 400 {
		s = s[:400] + "…"
	}
	return s
}

// findDrugClearance returns the first clearance match that is about the drug,
// skipping "creatinine clearance" (a renal-function covariate that labels
// quote in mL/min and that would otherwise pass as drug clearance).
func findDrugClearance(text string) []int {
	for _, m := range reClearance.FindAllStringSubmatchIndex(text, -1) {
		before := strings.ToLower(text[max(0, m[0]-16):m[0]])
		if strings.Contains(before, "creatinin") {
			continue
		}
		return m
	}
	return nil
}
