package biomed

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Bridge composes the sources into one evidence-carrying consult and grows
// the on-disk knowledge graph as a side effect.
type Bridge struct {
	Client    *Client
	Graph     *KnowledgeGraph
	GraphPath string

	mu    sync.Mutex
	index *DrugNameIndex
}

// NewBridge creates a bridge whose cache and graph live under cacheDir.
func NewBridge(cacheDir string, opts ...ClientOption) (*Bridge, error) {
	return NewBridgeWithClient(NewClient(cacheDir, opts...))
}

// NewBridgeWithClient wraps an existing client; the graph is read from
// <cacheDir>/graph.json when present.
func NewBridgeWithClient(c *Client) (*Bridge, error) {
	path := filepath.Join(c.CacheDir(), "graph.json")
	g, err := LoadKnowledgeGraph(path)
	if err != nil {
		return nil, fmt.Errorf("biomed: load graph: %w", err)
	}
	return &Bridge{Client: c, Graph: g, GraphPath: path}, nil
}

// Index returns the drug-name index, loading it on first use.
func (b *Bridge) Index(ctx context.Context) (*DrugNameIndex, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.index != nil {
		return b.index, nil
	}
	ix, err := b.Client.LoadDrugNameIndex(ctx)
	if err != nil {
		return nil, err
	}
	b.index = ix
	return ix, nil
}

// ConsultRequest is what the caller knows.
type ConsultRequest struct {
	Query    string       `json:"query,omitempty"`    // free text; drug mentions are detected with the RxNorm index
	Drugs    []string     `json:"drugs,omitempty"`    // explicit drug names (any spelling)
	Diseases []string     `json:"diseases,omitempty"` // explicit disease names
	Patient  *Patient     `json:"patient,omitempty"`
	Regimen  *DoseRegimen `json:"regimen,omitempty"` // enables the PK simulation
}

// InteractionHit is a label sentence set mentioning one of the patient's drugs.
type InteractionHit struct {
	WithDrug string   `json:"with_drug"`
	Quotes   []string `json:"quotes"`
	Evidence Evidence `json:"evidence"`
}

// VariantHit is what the label and the literature say about a variant.
type VariantHit struct {
	Variant     Variant    `json:"variant"`
	LabelQuotes []string   `json:"label_quotes,omitempty"`
	PubMed      PubMedHits `json:"pubmed"`
}

// DrugReport is everything learned about one drug.
type DrugReport struct {
	Drug               Drug             `json:"drug"`
	Molecule           *Molecule        `json:"molecule,omitempty"`
	Mechanisms         []Mechanism      `json:"mechanisms,omitempty"`
	Targets            []Target         `json:"targets,omitempty"`
	TargetAssociations []OTTarget       `json:"target_associations,omitempty"`
	TopActivities      []Activity       `json:"top_activities,omitempty"`
	Label              *Label           `json:"label,omitempty"`
	BoxedWarning       []string         `json:"boxed_warning,omitempty"`
	Contraindications  []string         `json:"contraindications,omitempty"`
	Interactions       []InteractionHit `json:"interactions,omitempty"`
	VariantHits        []VariantHit     `json:"variant_hits,omitempty"`
	PK                 *PKParameters    `json:"pk,omitempty"`
	Simulation         *PKSimulation    `json:"simulation,omitempty"`
	OrganNotes         []string         `json:"organ_notes,omitempty"`
	Missing            []string         `json:"missing,omitempty"`
}

// ConsultResponse is the evidence-carrying answer.
type ConsultResponse struct {
	Drugs               []DrugReport `json:"drugs"`
	Diseases            []OTDisease  `json:"diseases,omitempty"`
	Confidence          float64      `json:"confidence"`
	ConfidenceRationale string       `json:"confidence_rationale"`
	Sources             []Evidence   `json:"sources"`
	Missing             []string     `json:"missing,omitempty"`
	Disclaimer          string       `json:"disclaimer"`
}

// Disclaimer accompanies every response.
const Disclaimer = "Informații extrase automat din surse publice (RxNorm, ChEMBL, openFDA, Open Targets, PubMed) la data indicată în fiecare dovadă. Nu constituie sfat medical; deciziile clinice aparțin medicului."

// organTerms select label sentences about organ impairment when the patient
// has such labs. labTerms decide whether the patient HAS such labs. These are
// vocabulary for reading the caller's own data, not medical rules.
var (
	organTerms = []string{"renal", "hepatic", "kidney", "liver", "impairment", "creatinine"}
	labTerms   = []string{"egfr", "creatinin", "alt", "ast", "bilirubin", "gfr", "alat", "asat"}
)

// Consult resolves every drug in the request, gathers what the sources know,
// records it in the graph and returns it with evidence. ErrNotFound when no
// drug could be identified; ErrOffline when a source is unreachable for the
// drug's identity (later sources being offline is reported in Missing).
func (b *Bridge) Consult(ctx context.Context, req ConsultRequest) (*ConsultResponse, error) {
	names, err := b.collectDrugNames(ctx, req)
	if err != nil {
		return nil, err
	}
	resp := &ConsultResponse{Disclaimer: Disclaimer}
	seen := map[string]bool{}
	var firstErr error
	for _, name := range names {
		drug, err := b.Client.NormalizeDrug(ctx, name)
		if err != nil {
			if errors.Is(err, ErrOffline) {
				return nil, err
			}
			resp.Missing = append(resp.Missing, fmt.Sprintf("%q not found in RxNorm", name))
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if seen[drug.RxCUI] {
			continue
		}
		seen[drug.RxCUI] = true
		resp.Drugs = append(resp.Drugs, b.reportDrug(ctx, drug, req))
	}
	if len(resp.Drugs) == 0 {
		if firstErr != nil {
			return nil, firstErr
		}
		return nil, fmt.Errorf("biomed: no drug identified in request: %w", ErrNotFound)
	}
	b.crossInteractions(ctx, resp, req)
	b.reportDiseases(ctx, req, resp)
	for _, d := range resp.Drugs {
		resp.Missing = append(resp.Missing, d.Missing...)
	}
	resp.Sources = collectSources(resp)
	resp.Confidence, resp.ConfidenceRationale = confidence(resp, req)
	if b.GraphPath != "" {
		if err := b.Graph.Save(b.GraphPath); err != nil {
			resp.Missing = append(resp.Missing, "graph not saved: "+err.Error())
		}
	}
	return resp, nil
}

func (b *Bridge) collectDrugNames(ctx context.Context, req ConsultRequest) ([]string, error) {
	names := append([]string(nil), req.Drugs...)
	if strings.TrimSpace(req.Query) != "" {
		ix, err := b.Index(ctx)
		if err != nil {
			if len(names) == 0 {
				return nil, err
			}
		} else {
			for _, m := range ix.FindMentions(req.Query) {
				names = append(names, m.Text)
			}
		}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("biomed: no drug named or mentioned: %w", ErrNotFound)
	}
	return names, nil
}

func (b *Bridge) reportDrug(ctx context.Context, drug Drug, req ConsultRequest) DrugReport {
	r := DrugReport{Drug: drug}
	drugID := "rxcui:" + drug.RxCUI
	b.Graph.AddEntity(Entity{ID: drugID, Name: drug.Name, Kind: "drug"})
	miss := func(what string, err error) {
		if errors.Is(err, ErrNotFound) {
			r.Missing = append(r.Missing, fmt.Sprintf("%s: %s has no record", drug.Name, what))
		} else {
			r.Missing = append(r.Missing, fmt.Sprintf("%s: %s unavailable (%v)", drug.Name, what, err))
		}
	}

	// ChEMBL: identity, mechanism, targets, activities.
	if mol, err := b.Client.Molecule(ctx, drug.Name); err != nil {
		miss("ChEMBL molecule", err)
	} else {
		r.Molecule = &mol
		b.Graph.AddEntity(Entity{ID: "chembl:" + mol.ChEMBLID, Name: mol.PrefName, Kind: "drug"})
		b.Graph.AddEdge(Edge{From: drugID, To: "chembl:" + mol.ChEMBLID, Relation: "same_as", Evidence: []Evidence{mol.Evidence}})
		if mechs, err := b.Client.Mechanisms(ctx, mol.ChEMBLID); err != nil {
			miss("ChEMBL mechanism", err)
		} else {
			r.Mechanisms = mechs
			for _, m := range mechs {
				if m.TargetChEMBLID == "" {
					continue
				}
				tg, err := b.Client.Target(ctx, m.TargetChEMBLID)
				if err != nil {
					miss("ChEMBL target "+m.TargetChEMBLID, err)
					continue
				}
				r.Targets = append(r.Targets, tg)
				b.Graph.AddEntity(Entity{ID: "chembl:" + tg.ChEMBLID, Name: tg.PrefName, Kind: "target"})
				b.Graph.AddEdge(Edge{From: drugID, To: "chembl:" + tg.ChEMBLID, Relation: "targets", Evidence: []Evidence{m.Evidence, tg.Evidence}})
				for _, sym := range tg.GeneSymbols {
					b.linkTargetAssociations(ctx, &r, drugID, sym)
					break // one symbol per target is enough for associations
				}
			}
		}
		// Potency against the mechanism's own target; any target only as fallback.
		targetID := ""
		for _, m := range r.Mechanisms {
			if m.TargetChEMBLID != "" {
				targetID = m.TargetChEMBLID
				break
			}
		}
		acts, err := b.Client.ActivitiesForTarget(ctx, mol.ChEMBLID, targetID, 5)
		if err == nil && len(acts) == 0 && targetID != "" {
			acts, err = b.Client.Activities(ctx, mol.ChEMBLID, 5)
		}
		if err != nil {
			miss("ChEMBL activities", err)
		} else {
			r.TopActivities = acts
		}
	}

	// openFDA label and everything derived from it.
	label, err := b.Client.Label(ctx, drug.Name)
	if err != nil {
		miss("FDA label", err)
	} else {
		r.Label = &label
		b.Graph.AddEntity(Entity{ID: "label:" + label.SetID, Name: "FDA label " + drug.Name, Kind: "label"})
		b.Graph.AddEdge(Edge{From: drugID, To: "label:" + label.SetID, Relation: "has_label", Evidence: []Evidence{label.Evidence}})
		r.BoxedWarning = firstSentences(label.Sections["boxed_warning"], 5)
		r.Contraindications = firstSentences(label.Sections["contraindications"], 5)
		for _, sec := range label.MissingSections("drug_interactions", "contraindications") {
			r.Missing = append(r.Missing, fmt.Sprintf("%s: label has no %s section", drug.Name, sec))
		}
		b.variants(ctx, &r, drug, label, req)
		pkText := label.Sections["pharmacokinetics"]
		if pkText == "" {
			pkText = label.Sections["clinical_pharmacology"]
		}
		if pkText == "" {
			r.Missing = append(r.Missing, drug.Name+": label has no pharmacokinetics section (nor clinical_pharmacology)")
		} else {
			pk := ExtractPK(pkText)
			r.PK = &pk
			if req.Regimen != nil {
				sim, err := Simulate(pk, *req.Regimen)
				if err != nil {
					r.Missing = append(r.Missing, fmt.Sprintf("%s: pharmacokinetic simulation not possible (%v)", drug.Name, err))
				} else {
					r.Simulation = &sim
				}
			}
		}
		if req.Patient != nil && hasOrganLabs(req.Patient) {
			for _, sec := range []string{"use_in_specific_populations", "dosage_and_administration", "warnings_and_cautions"} {
				for _, term := range organTerms {
					r.OrganNotes = appendUnique(r.OrganNotes, label.FindInSection(sec, term)...)
				}
			}
		}
	}
	return r
}

func (b *Bridge) linkTargetAssociations(ctx context.Context, r *DrugReport, drugID, symbol string) {
	hits, err := b.Client.OTSearch(ctx, symbol, "target")
	if err != nil || len(hits) == 0 {
		if err != nil {
			r.Missing = append(r.Missing, "Open Targets search for "+symbol+" unavailable: "+err.Error())
		}
		return
	}
	tg, err := b.Client.OTTarget(ctx, hits[0].ID, 5)
	if err != nil {
		r.Missing = append(r.Missing, "Open Targets target "+hits[0].ID+" unavailable: "+err.Error())
		return
	}
	r.TargetAssociations = append(r.TargetAssociations, tg)
	tid := "ensembl:" + tg.ID
	b.Graph.AddEntity(Entity{ID: tid, Name: tg.Symbol, Kind: "target"})
	b.Graph.AddEdge(Edge{From: drugID, To: tid, Relation: "targets", Evidence: []Evidence{tg.Evidence}})
	for _, d := range tg.Diseases {
		score := d.Score
		b.Graph.AddEntity(Entity{ID: "disease:" + d.DiseaseID, Name: d.DiseaseName, Kind: "disease"})
		b.Graph.AddEdge(Edge{From: tid, To: "disease:" + d.DiseaseID, Relation: "associated_with", Score: &score, Evidence: []Evidence{tg.Evidence}})
	}
}

// crossInteractions searches every drug's drug_interactions section for the
// other drugs of the same consult and for the patient's active medications.
// A label without that section was already reported in Missing.
func (b *Bridge) crossInteractions(ctx context.Context, resp *ConsultResponse, req ConsultRequest) {
	for i := range resp.Drugs {
		r := &resp.Drugs[i]
		if r.Label == nil || r.Label.Sections["drug_interactions"] == "" {
			continue
		}
		var others []string
		for j := range resp.Drugs {
			if j != i {
				others = append(others, resp.Drugs[j].Drug.Name)
			}
		}
		if req.Patient != nil {
			others = append(others, req.Patient.ActiveMedications...)
		}
		seen := map[string]bool{}
		for _, med := range others {
			name := strings.ToLower(strings.TrimSpace(med))
			if name == "" || name == r.Drug.Name {
				continue
			}
			// Search by the canonical RxNorm name when it resolves, else by the raw text.
			terms := []string{name}
			if d, err := b.Client.NormalizeDrug(ctx, med); err == nil && d.Name != name {
				terms = append([]string{d.Name}, terms...)
			}
			for _, term := range terms {
				if seen[term] {
					break
				}
				if quotes := r.Label.FindInSection("drug_interactions", term); len(quotes) > 0 {
					seen[term] = true
					r.Interactions = append(r.Interactions, InteractionHit{WithDrug: term, Quotes: quotes, Evidence: r.Label.Evidence})
					b.Graph.AddEdge(Edge{From: "rxcui:" + r.Drug.RxCUI, To: "drugname:" + term, Relation: "interacts_with", Evidence: []Evidence{r.Label.Evidence}})
					break
				}
			}
		}
	}
}

func (b *Bridge) variants(ctx context.Context, r *DrugReport, drug Drug, label Label, req ConsultRequest) {
	if req.Patient == nil {
		return
	}
	for _, v := range req.Patient.Variants {
		if v.Change == "" && v.Gene == "" {
			continue
		}
		hit := VariantHit{Variant: v}
		needle := v.Change
		if needle == "" {
			needle = v.Gene
		}
		for _, sec := range []string{"indications_and_usage", "clinical_studies", "warnings_and_cautions", "clinical_pharmacology", "dosage_and_administration"} {
			hit.LabelQuotes = appendUnique(hit.LabelQuotes, label.FindInSection(sec, needle)...)
		}
		term := fmt.Sprintf("%s AND %s", drug.Name, v.String())
		if pm, err := b.Client.PubMedSearch(ctx, term, 5); err != nil {
			r.Missing = append(r.Missing, fmt.Sprintf("%s: PubMed unavailable for %q (%v)", drug.Name, term, err))
		} else {
			hit.PubMed = pm
			vid := "variant:" + v.Gene + ":" + v.Change
			b.Graph.AddEntity(Entity{ID: vid, Name: v.String(), Kind: "variant"})
			b.Graph.AddEdge(Edge{From: "rxcui:" + drug.RxCUI, To: vid, Relation: "mentioned_with", Evidence: []Evidence{pm.Evidence}})
		}
		r.VariantHits = append(r.VariantHits, hit)
	}
}

func (b *Bridge) reportDiseases(ctx context.Context, req ConsultRequest, resp *ConsultResponse) {
	names := append([]string(nil), req.Diseases...)
	if req.Patient != nil {
		names = append(names, req.Patient.Conditions...)
	}
	seen := map[string]bool{}
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			continue
		}
		hits, err := b.Client.OTSearch(ctx, name, "disease")
		if err != nil {
			resp.Missing = append(resp.Missing, fmt.Sprintf("Open Targets search for %q unavailable (%v)", name, err))
			continue
		}
		if len(hits) == 0 {
			resp.Missing = append(resp.Missing, fmt.Sprintf("%q not found in Open Targets", name))
			continue
		}
		if seen[hits[0].ID] {
			continue
		}
		seen[hits[0].ID] = true
		d, err := b.Client.OTDisease(ctx, hits[0].ID, 5)
		if err != nil {
			resp.Missing = append(resp.Missing, fmt.Sprintf("Open Targets disease %s unavailable (%v)", hits[0].ID, err))
			continue
		}
		resp.Diseases = append(resp.Diseases, d)
		did := "disease:" + d.ID
		b.Graph.AddEntity(Entity{ID: did, Name: d.Name, Kind: "disease"})
		for _, c := range d.Candidates {
			b.Graph.AddEntity(Entity{ID: "chembl:" + c.DrugChEMBLID, Name: c.DrugName, Kind: "drug"})
			b.Graph.AddEdge(Edge{From: "chembl:" + c.DrugChEMBLID, To: did, Relation: "candidate_for", Evidence: []Evidence{d.Evidence}})
		}
	}
}

// confidence is a documented, monotone function of what the sources returned.
// It never exceeds 1 and is 0 when nothing beyond RxNorm was found.
func confidence(resp *ConsultResponse, req ConsultRequest) (float64, string) {
	score := 0.0
	var why []string
	add := func(v float64, reason string) {
		score += v
		why = append(why, fmt.Sprintf("+%.2f %s", v, reason))
	}
	for _, d := range resp.Drugs {
		if d.Drug.RxCUI != "" {
			add(0.25, d.Drug.Name+": RxNorm identity")
		}
		if d.Label != nil {
			add(0.25, d.Drug.Name+": FDA label")
		}
		if len(d.Mechanisms) > 0 {
			add(0.20, d.Drug.Name+": ChEMBL mechanism")
		}
		if d.Molecule != nil && d.Molecule.MaxPhase != nil && *d.Molecule.MaxPhase >= 4 {
			add(0.10, d.Drug.Name+": approved (ChEMBL max_phase 4)")
		}
		for _, v := range d.VariantHits {
			if v.PubMed.Count > 0 {
				add(0.10, fmt.Sprintf("%s: %d PubMed records for %s", d.Drug.Name, v.PubMed.Count, v.Variant.String()))
				break
			}
		}
		break // confidence is about the primary drug; others only add Missing entries
	}
	if len(resp.Diseases) > 0 {
		add(0.10, "Open Targets association for requested disease")
	}
	if score > 1 {
		score = 1
	}
	if len(resp.Missing) > 0 {
		why = append(why, fmt.Sprintf("(%d items missing)", len(resp.Missing)))
	}
	return score, strings.Join(why, "; ")
}

func collectSources(resp *ConsultResponse) []Evidence {
	var out []Evidence
	addEv := func(e Evidence) {
		if e.Source == "" {
			return
		}
		if !hasEvidence(out, e) {
			out = append(out, e)
		}
	}
	for _, d := range resp.Drugs {
		addEv(d.Drug.Evidence)
		if d.Molecule != nil {
			addEv(d.Molecule.Evidence)
		}
		for _, m := range d.Mechanisms {
			addEv(m.Evidence)
		}
		for _, t := range d.Targets {
			addEv(t.Evidence)
		}
		for _, t := range d.TargetAssociations {
			addEv(t.Evidence)
		}
		for _, a := range d.TopActivities {
			addEv(a.Evidence)
		}
		if d.Label != nil {
			addEv(d.Label.Evidence)
		}
		for _, v := range d.VariantHits {
			addEv(v.PubMed.Evidence)
		}
	}
	for _, dis := range resp.Diseases {
		addEv(dis.Evidence)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Source < out[j].Source })
	return out
}

func hasOrganLabs(p *Patient) bool {
	for name := range p.Labs {
		l := strings.ToLower(name)
		for _, t := range labTerms {
			if strings.Contains(l, t) {
				return true
			}
		}
	}
	return false
}

func firstSentences(text string, n int) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var out []string
	for _, s := range sentenceEnd.Split(text, -1) {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if len(s) > 600 {
			s = s[:600] + "…"
		}
		out = append(out, s)
		if len(out) == n {
			break
		}
	}
	return out
}

func appendUnique(dst []string, items ...string) []string {
	for _, it := range items {
		dup := false
		for _, d := range dst {
			if d == it {
				dup = true
				break
			}
		}
		if !dup {
			dst = append(dst, it)
		}
	}
	return dst
}
