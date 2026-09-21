package biomed

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// pk_extract.go pulls pharmacokinetic parameters out of the free-text
// "Pharmacokinetics" section of an FDA label. Every value keeps the sentence
// it was taken from; anything the text does not state stays nil.
//
// Strategy (after the 2026-09-21 review against 40 live labels):
//   - the text is split into sentences (a '.' between digits is a decimal
//     point, not a boundary), so a quote always contains its number;
//   - each parameter needs its keyword AND its number in the same sentence
//     (or the same comma clause for percentages), which stops "90% CI …
//     upper boundary" from becoming protein binding;
//   - per-kilogram units (L/kg, mL/min/kg) are rejected, never treated as
//     absolute values;
//   - renal/creatinine/hepatic clearance is not the drug's clearance;
//   - sentences about impaired populations are only used when no
//     healthy-subject sentence states the parameter.

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

const num = `(\d+(?:[.,]\d+)?)`

var (
	reHalfLife  = regexp.MustCompile(`(?i)half-?\s?li(?:fe|ves).{0,120}?` + num + `\s*(hours?|hrs?|h|days?|minutes?|min)\b`)
	reVd        = regexp.MustCompile(`(?i)volume of distribution.{0,80}?` + num + `\s*(liters?|litres?|L)\b`)
	reClearance = regexp.MustCompile(`(?i)clearance.{0,80}?` + num + `\s*(L/h(?:r|our)?|mL/min(?:ute)?|L/min(?:ute)?)\b`)
	rePercent   = regexp.MustCompile(num + `\s*%`)

	reProteinWord  = regexp.MustCompile(`(?i)\b(?:proteins?|albumin)\b`)
	reBoundWord    = regexp.MustCompile(`(?i)\b(?:bound|binding)\b`)
	reExcretion    = regexp.MustCompile(`(?i)excret|eliminat|recover|accounting for|clearance of`)
	reRenalSite    = regexp.MustCompile(`(?i)\b(?:urine|urinary|renal|renally|kidneys?)\b`)
	reImpairment   = regexp.MustCompile(`(?i)impair|cirrhosis|dialysis|pediatric|geriatric|elderly|children`)
	reNotDrugClear = regexp.MustCompile(`(?i)(?:renal|creatinine?|hepatic|biliary|intrinsic|non-?renal)\s*$`)
)

// ExtractPK parses a pharmacokinetics section. Empty or number-free text
// yields an all-nil result.
func ExtractPK(text string) PKParameters {
	var pk PKParameters
	if strings.TrimSpace(text) == "" {
		return pk
	}
	sentences := splitSentences(text)
	pk.HalfLifeHours = findFirst(sentences, matchHalfLife)
	pk.VdLiters = findFirst(sentences, matchVd)
	pk.ClearanceLPerHour = findFirst(sentences, matchClearance)
	pk.ProteinBoundFraction = findFirst(sentences, matchProteinBinding)
	pk.RenalFraction = findFirst(sentences, matchRenalFraction)
	return pk
}

// findFirst applies a matcher sentence by sentence, preferring sentences that
// do not describe an impaired population.
func findFirst(sentences []string, match func(string) *Measured) *Measured {
	for pass := 0; pass < 2; pass++ {
		for _, s := range sentences {
			if pass == 0 && reImpairment.MatchString(s) {
				continue
			}
			if m := match(s); m != nil {
				m.Quote = truncateRunes(s, 400)
				return m
			}
		}
	}
	return nil
}

func matchHalfLife(s string) *Measured {
	m := reHalfLife.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	v := parseNum(m[1])
	unit := strings.ToLower(m[2])
	switch {
	case strings.HasPrefix(unit, "day"):
		v *= 24
	case strings.HasPrefix(unit, "min"):
		v /= 60
	}
	return &Measured{Value: v, Unit: "h"}
}

func matchVd(s string) *Measured {
	m := reVd.FindStringSubmatchIndex(s)
	if m == nil || perDenominator(s, m[5]) {
		return nil // "0.16 L/kg" is not an absolute volume
	}
	return &Measured{Value: parseNum(s[m[2]:m[3]]), Unit: "L"}
}

func matchClearance(s string) *Measured {
	for _, m := range reClearance.FindAllStringSubmatchIndex(s, -1) {
		before := s[max(0, m[0]-20):m[0]]
		if reNotDrugClear.MatchString(before) || perDenominator(s, m[5]) {
			continue
		}
		v := parseNum(s[m[2]:m[3]])
		unit := strings.ToLower(s[m[4]:m[5]])
		switch {
		case strings.HasPrefix(unit, "ml/min"):
			v = v * 60 / 1000
		case strings.HasPrefix(unit, "l/min"):
			v *= 60
		}
		return &Measured{Value: v, Unit: "L/h"}
	}
	return nil
}

// perDenominator reports whether the unit ending at byte offset end is
// followed by "/..." (L/kg, mL/min/kg, L/h/m²).
func perDenominator(s string, end int) bool {
	rest := strings.TrimLeft(s[end:], " ")
	return strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, "per ")
}

func matchProteinBinding(s string) *Measured {
	for _, clause := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' }) {
		if !reProteinWord.MatchString(clause) || !reBoundWord.MatchString(clause) {
			continue
		}
		if m := rePercent.FindStringSubmatch(clause); m != nil {
			return &Measured{Value: parseNum(m[1]) / 100, Unit: "fraction"}
		}
	}
	return nil
}

func matchRenalFraction(s string) *Measured {
	if !reExcretion.MatchString(s) {
		return nil
	}
	for _, clause := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' }) {
		for _, part := range splitOnAndIfBothHavePercent(clause) {
			if !reRenalSite.MatchString(part) {
				continue
			}
			if m := rePercent.FindStringSubmatch(part); m != nil {
				return &Measured{Value: parseNum(m[1]) / 100, Unit: "fraction"}
			}
		}
	}
	return nil
}

// splitOnAndIfBothHavePercent separates "60% in urine and 30% in feces" into
// its two halves; a clause with a single percentage stays whole.
func splitOnAndIfBothHavePercent(clause string) []string {
	parts := strings.Split(clause, " and ")
	if len(parts) < 2 {
		return []string{clause}
	}
	for _, p := range parts {
		if !rePercent.MatchString(p) {
			return []string{clause}
		}
	}
	return parts
}

// splitSentences breaks text at '.', ';' or newline, except when the '.' is a
// decimal point (followed by a digit).
func splitSentences(text string) []string {
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		c := text[i]
		boundary := c == ';' || c == '\n'
		if c == '.' {
			next := byte(' ')
			if i+1 < len(text) {
				next = text[i+1]
			}
			boundary = !(next >= '0' && next <= '9')
		}
		if boundary {
			if s := strings.TrimSpace(text[start:i]); s != "" {
				out = append(out, s)
			}
			start = i + 1
		}
	}
	if s := strings.TrimSpace(text[start:]); s != "" {
		out = append(out, s)
	}
	return out
}

func parseNum(s string) float64 {
	v, _ := strconv.ParseFloat(strings.ReplaceAll(s, ",", "."), 64)
	return v
}

// truncateRunes shortens s to at most n runes without splitting a character.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return strings.TrimRightFunc(s[:i], unicode.IsSpace) + "…"
		}
		count++
	}
	return s
}
