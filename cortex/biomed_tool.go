package cortex

// biomed_tool.go — adapts the biomedical knowledge organ (cortex/biomed) to
// the organism's Tool interface. The organ answers only from live public
// sources with evidence; this file only decides WHEN it speaks (a drug is
// mentioned) and HOW the structured answer is rendered as text.

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"nexus-cortex/cortex/biomed"
)

const (
	biomedMatchTimeout   = 8 * time.Second
	biomedExecuteTimeout = 60 * time.Second
)

// BiomedTool routes drug-related questions to the biomedical organ.
type BiomedTool struct {
	cacheDir string

	mu     sync.Mutex
	bridge *biomed.Bridge
	err    error
}

// NewBiomedTool creates a tool whose cache and knowledge graph live under cacheDir.
// The bridge (and the RxNorm name index) are created lazily on first use.
func NewBiomedTool(cacheDir string) *BiomedTool {
	return &BiomedTool{cacheDir: cacheDir}
}

// NewBiomedToolWithBridge wraps an existing bridge (tests inject fixtures).
func NewBiomedToolWithBridge(b *biomed.Bridge) *BiomedTool {
	return &BiomedTool{bridge: b}
}

// Name implements Tool.
func (t *BiomedTool) Name() string { return "biomed" }

func (t *BiomedTool) getBridge() (*biomed.Bridge, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.bridge != nil || t.err != nil {
		return t.bridge, t.err
	}
	t.bridge, t.err = biomed.NewBridge(t.cacheDir)
	return t.bridge, t.err
}

// Match implements Tool: true when the RxNorm name index finds at least one
// drug mention. Offline with no cached index → false (the tool stays silent).
func (t *BiomedTool) Match(lower string) bool {
	b, err := t.getBridge()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), biomedMatchTimeout)
	defer cancel()
	ix, err := b.Index(ctx)
	if err != nil {
		return false
	}
	return len(ix.FindMentions(lower)) > 0
}

// Execute implements Tool: runs a consult and renders it with sources.
func (t *BiomedTool) Execute(input string) (string, bool) {
	b, err := t.getBridge()
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), biomedExecuteTimeout)
	defer cancel()
	res, err := b.Consult(ctx, biomed.ConsultRequest{Query: input})
	if err != nil {
		return "", false
	}
	return RenderConsult(res, looksRomanian(input)), true
}

// looksRomanian is a cheap language guess: Romanian diacritics or frequent
// Romanian function words. It only picks the rendering language.
func looksRomanian(s string) bool {
	if strings.ContainsAny(s, "ăâîșțĂÂÎȘȚ") {
		return true
	}
	words := strings.Fields(strings.ToLower(s))
	hits := 0
	for _, w := range words {
		switch w {
		case "ce", "este", "si", "cu", "la", "de", "pentru", "care", "cum", "sau", "iau", "ia", "pacient", "pacientul":
			hits++
		}
	}
	return hits >= 2
}

type labels struct {
	identity, mechanism, label, boxed, contra, interactions, variants, pk, sim, organ, missing, confidence, sources, phase, approved, none string
}

var (
	labelsRO = labels{"Identitate", "Mecanism de acțiune", "Prospect FDA", "Avertizare încadrată", "Contraindicații", "Interacțiuni (din prospect)", "Variante genomice", "Farmacocinetică (extrasă din prospect)", "Simulare PK (model cu un compartiment)", "Note despre funcția renală/hepatică", "Nu s-a putut afla", "Confidență", "Surse", "fază clinică", "aprobat", "niciuna"}
	labelsEN = labels{"Identity", "Mechanism of action", "FDA label", "Boxed warning", "Contraindications", "Interactions (from the label)", "Genomic variants", "Pharmacokinetics (extracted from the label)", "PK simulation (one-compartment model)", "Renal/hepatic notes", "Could not determine", "Confidence", "Sources", "clinical phase", "approved", "none"}
)

// RenderConsult renders a ConsultResponse as plain text with its sources.
func RenderConsult(res *biomed.ConsultResponse, romanian bool) string {
	l := labelsEN
	if romanian {
		l = labelsRO
	}
	var sb strings.Builder
	for _, d := range res.Drugs {
		fmt.Fprintf(&sb, "## %s\n", strings.ToUpper(d.Drug.Name))
		fmt.Fprintf(&sb, "%s: RxCUI %s", l.identity, d.Drug.RxCUI)
		if d.Molecule != nil {
			fmt.Fprintf(&sb, " | ChEMBL %s", d.Molecule.ChEMBLID)
			if d.Molecule.MaxPhase >= 4 {
				fmt.Fprintf(&sb, " (%s)", l.approved)
			} else {
				fmt.Fprintf(&sb, " (%s %.0f)", l.phase, d.Molecule.MaxPhase)
			}
			if len(d.Molecule.ATC) > 0 {
				fmt.Fprintf(&sb, " | ATC %s", strings.Join(d.Molecule.ATC, ","))
			}
		}
		sb.WriteString("\n")
		if len(d.Mechanisms) > 0 {
			fmt.Fprintf(&sb, "%s:\n", l.mechanism)
			for i, m := range d.Mechanisms {
				line := fmt.Sprintf("  - %s: %s", m.Action, m.Description)
				if i < len(d.Targets) {
					tg := d.Targets[i]
					line += fmt.Sprintf(" [%s, %s]", tg.PrefName, strings.Join(tg.GeneSymbols, "/"))
				}
				sb.WriteString(line + "\n")
			}
		}
		if len(d.TopActivities) > 0 {
			a := d.TopActivities[0]
			fmt.Fprintf(&sb, "  - %s %g %s vs %s (ChEMBL %s)\n", a.Type, a.Value, a.Units, a.TargetName, a.DocumentID)
		}
		if d.Label != nil {
			fmt.Fprintf(&sb, "%s: set_id %s (%s)\n", l.label, d.Label.SetID, d.Label.EffectiveTime)
			if len(d.BoxedWarning) > 0 {
				fmt.Fprintf(&sb, "  %s: %s\n", l.boxed, d.BoxedWarning[0])
			}
			for i, c := range d.Contraindications {
				if i == 2 {
					break
				}
				fmt.Fprintf(&sb, "  %s: %s\n", l.contra, c)
			}
		}
		if len(d.Interactions) > 0 {
			fmt.Fprintf(&sb, "%s:\n", l.interactions)
			for _, ih := range d.Interactions {
				fmt.Fprintf(&sb, "  - %s: %s\n", ih.WithDrug, ih.Quotes[0])
			}
		}
		if len(d.VariantHits) > 0 {
			fmt.Fprintf(&sb, "%s:\n", l.variants)
			for _, v := range d.VariantHits {
				fmt.Fprintf(&sb, "  - %s: PubMed %d (%s)", v.Variant.String(), v.PubMed.Count, v.PubMed.Query)
				if len(v.LabelQuotes) > 0 {
					fmt.Fprintf(&sb, " | %s: %s", l.label, v.LabelQuotes[0])
				}
				sb.WriteString("\n")
			}
		}
		if d.PK != nil {
			fmt.Fprintf(&sb, "%s:", l.pk)
			any := false
			if d.PK.HalfLifeHours != nil {
				fmt.Fprintf(&sb, " t½ %s h;", num(d.PK.HalfLifeHours.Value))
				any = true
			}
			if d.PK.VdLiters != nil {
				fmt.Fprintf(&sb, " Vd %s L;", num(d.PK.VdLiters.Value))
				any = true
			}
			if d.PK.ClearanceLPerHour != nil {
				fmt.Fprintf(&sb, " CL %s L/h;", num(d.PK.ClearanceLPerHour.Value))
				any = true
			}
			if d.PK.ProteinBoundFraction != nil {
				fmt.Fprintf(&sb, " protein binding %.0f%%;", d.PK.ProteinBoundFraction.Value*100)
				any = true
			}
			if d.PK.RenalFraction != nil {
				fmt.Fprintf(&sb, " renal %.0f%%;", d.PK.RenalFraction.Value*100)
				any = true
			}
			if !any {
				sb.WriteString(" " + l.none)
			}
			sb.WriteString("\n")
		}
		if d.Simulation != nil {
			s := d.Simulation
			fmt.Fprintf(&sb, "%s: %g mg q%gh → Cmax,ss %.3g mg/L, Cmin,ss %.3g mg/L, AUCτ %.3g mg·h/L\n",
				l.sim, s.Regimen.DoseMg, s.Regimen.IntervalHours, s.CmaxSS, s.CminSS, s.AUCPerInterval)
		}
		if len(d.OrganNotes) > 0 {
			fmt.Fprintf(&sb, "%s:\n", l.organ)
			for i, n := range d.OrganNotes {
				if i == 3 {
					break
				}
				fmt.Fprintf(&sb, "  - %s\n", n)
			}
		}
	}
	for _, dis := range res.Diseases {
		fmt.Fprintf(&sb, "## %s (%s)\n", dis.Name, dis.ID)
		for i, tg := range dis.Targets {
			if i == 3 {
				break
			}
			fmt.Fprintf(&sb, "  - target %s score %.2f\n", tg.Symbol, tg.Score)
		}
	}
	if len(res.Missing) > 0 {
		fmt.Fprintf(&sb, "%s:\n", l.missing)
		for i, m := range res.Missing {
			if i == 6 {
				fmt.Fprintf(&sb, "  - … (+%d)\n", len(res.Missing)-6)
				break
			}
			fmt.Fprintf(&sb, "  - %s\n", m)
		}
	}
	fmt.Fprintf(&sb, "%s: %.2f (%s)\n", l.confidence, res.Confidence, res.ConfidenceRationale)
	fmt.Fprintf(&sb, "%s:\n", l.sources)
	for _, s := range res.Sources {
		name := s.Source
		if name == "openfda" {
			name = "openFDA"
		}
		fmt.Fprintf(&sb, "  - %s %s: %s\n", name, s.ID, s.URL)
	}
	sb.WriteString(res.Disclaimer + "\n")
	return sb.String()
}

// num formats a quantity without scientific notation (1400 → "1400", 0.4312 → "0.431").
func num(v float64) string {
	if v != 0 && (v < 0.01 || v >= 1e6) {
		return strconv.FormatFloat(v, 'g', 3, 64)
	}
	s := strconv.FormatFloat(v, 'f', 3, 64)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	if s == "" || s == "-" {
		return "0"
	}
	return s
}
