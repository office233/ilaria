package biomed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ChEMBL (EMBL-EBI) supplies molecule identity and physico-chemical
// properties, curated mechanisms of action with their protein targets, and
// measured bioactivities (IC50/Ki) with literature references.
//
// Endpoints (no API key): https://www.ebi.ac.uk/chembl/api/data/...

const chemblBase = "https://www.ebi.ac.uk/chembl/api/data"

// Molecule is a ChEMBL compound record.
type Molecule struct {
	ChEMBLID        string        `json:"chembl_id"`
	PrefName        string        `json:"pref_name"`
	MaxPhase        *float64      `json:"max_phase,omitempty"` // 4 = approved; nil = not stated by ChEMBL
	BlackBoxWarning bool          `json:"black_box_warning"`
	ATC             []string      `json:"atc,omitempty"`
	Props           MoleculeProps `json:"props"`
	Evidence        Evidence      `json:"evidence"`
}

// MoleculeProps are ChEMBL-computed properties. nil = not reported.
type MoleculeProps struct {
	MW            *float64 `json:"mw,omitempty"`
	ALogP         *float64 `json:"alogp,omitempty"`
	PSA           *float64 `json:"psa,omitempty"`
	HBA           *int     `json:"hba,omitempty"`
	HBD           *int     `json:"hbd,omitempty"`
	Ro5Violations *int     `json:"ro5_violations,omitempty"`
}

// Mechanism is a curated mechanism-of-action record.
type Mechanism struct {
	Action         string   `json:"action"`      // INHIBITOR, AGONIST, ...
	Description    string   `json:"description"` // e.g. "Epidermal growth factor receptor erbB1 inhibitor"
	TargetChEMBLID string   `json:"target_chembl_id"`
	MaxPhase       int      `json:"max_phase"`
	Evidence       Evidence `json:"evidence"`
}

// Target is a ChEMBL protein target.
type Target struct {
	ChEMBLID    string   `json:"chembl_id"`
	PrefName    string   `json:"pref_name"`
	Type        string   `json:"type"`
	Organism    string   `json:"organism"`
	GeneSymbols []string `json:"gene_symbols,omitempty"`
	UniProt     []string `json:"uniprot,omitempty"`
	Evidence    Evidence `json:"evidence"`
}

// Activity is one measured bioactivity value.
type Activity struct {
	Type           string   `json:"type"` // IC50, Ki
	Value          float64  `json:"value"`
	Units          string   `json:"units"`
	PChEMBL        *float64 `json:"pchembl,omitempty"`
	TargetChEMBLID string   `json:"target_chembl_id"`
	TargetName     string   `json:"target_name"`
	Assay          string   `json:"assay"`
	DocumentID     string   `json:"document_id"`
	Evidence       Evidence `json:"evidence"`
}

// chemblNumber decodes ChEMBL's mix of numeric strings, numbers and nulls.
type chemblNumber struct {
	v  float64
	ok bool
}

func (n *chemblNumber) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "null" || s == "" {
		n.ok = false
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		n.ok = false
		return nil
	}
	n.v, n.ok = f, true
	return nil
}

func (n chemblNumber) floatPtr() *float64 {
	if !n.ok {
		return nil
	}
	v := n.v
	return &v
}

func (n chemblNumber) intPtr() *int {
	if !n.ok {
		return nil
	}
	v := int(n.v)
	return &v
}

// Molecule looks a compound up by name (exact pref_name preferred, else the
// first search hit).
func (c *Client) Molecule(ctx context.Context, name string) (Molecule, error) {
	q := strings.ToLower(strings.TrimSpace(name))
	u := fmt.Sprintf("%s/molecule/search.json?q=%s&limit=5", chemblBase, url.QueryEscape(q))
	var out struct {
		Molecules []struct {
			ChEMBLID        string       `json:"molecule_chembl_id"`
			PrefName        string       `json:"pref_name"`
			MaxPhase        chemblNumber `json:"max_phase"`
			BlackBoxWarning int          `json:"black_box_warning"`
			ATC             []string     `json:"atc_classifications"`
			Props           *struct {
				MW  chemblNumber `json:"full_mwt"`
				ALo chemblNumber `json:"alogp"`
				PSA chemblNumber `json:"psa"`
				HBA chemblNumber `json:"hba"`
				HBD chemblNumber `json:"hbd"`
				Ro5 chemblNumber `json:"num_ro5_violations"`
			} `json:"molecule_properties"`
		} `json:"molecules"`
	}
	if _, err := c.GetJSON(ctx, "chembl", u, &out); err != nil {
		return Molecule{}, err
	}
	if len(out.Molecules) == 0 {
		return Molecule{}, fmt.Errorf("biomed/chembl: no molecule for %q: %w", q, ErrNotFound)
	}
	pick := 0
	for i, m := range out.Molecules {
		if strings.EqualFold(m.PrefName, q) {
			pick = i
			break
		}
	}
	m := out.Molecules[pick]
	mol := Molecule{
		ChEMBLID:        m.ChEMBLID,
		PrefName:        m.PrefName,
		MaxPhase:        m.MaxPhase.floatPtr(),
		BlackBoxWarning: m.BlackBoxWarning != 0,
		ATC:             m.ATC,
		Evidence: Evidence{
			Source: "chembl", ID: m.ChEMBLID, URL: u, Retrieved: time.Now().UTC(),
			Quote: fmt.Sprintf("search %q → %s (%s)", q, m.ChEMBLID, m.PrefName),
		},
	}
	if m.Props != nil {
		mol.Props = MoleculeProps{
			MW: m.Props.MW.floatPtr(), ALogP: m.Props.ALo.floatPtr(), PSA: m.Props.PSA.floatPtr(),
			HBA: m.Props.HBA.intPtr(), HBD: m.Props.HBD.intPtr(), Ro5Violations: m.Props.Ro5.intPtr(),
		}
	}
	return mol, nil
}

// Mechanisms returns the curated mechanisms of action for a compound.
func (c *Client) Mechanisms(ctx context.Context, chemblID string) ([]Mechanism, error) {
	u := fmt.Sprintf("%s/mechanism.json?molecule_chembl_id=%s", chemblBase, url.QueryEscape(chemblID))
	var out struct {
		Mechanisms []struct {
			Action   string `json:"action_type"`
			MoA      string `json:"mechanism_of_action"`
			Target   string `json:"target_chembl_id"`
			MaxPhase int    `json:"max_phase"`
			MecID    int    `json:"mec_id"`
		} `json:"mechanisms"`
	}
	if _, err := c.GetJSON(ctx, "chembl", u, &out); err != nil {
		return nil, err
	}
	res := make([]Mechanism, 0, len(out.Mechanisms))
	for _, m := range out.Mechanisms {
		res = append(res, Mechanism{
			Action: m.Action, Description: m.MoA, TargetChEMBLID: m.Target, MaxPhase: m.MaxPhase,
			Evidence: Evidence{Source: "chembl", ID: fmt.Sprintf("mec_id:%d", m.MecID), URL: u, Quote: m.MoA, Retrieved: time.Now().UTC()},
		})
	}
	return res, nil
}

// Target fetches a protein target with its gene symbols and UniProt accessions.
func (c *Client) Target(ctx context.Context, targetID string) (Target, error) {
	u := fmt.Sprintf("%s/target/%s.json", chemblBase, url.PathEscape(targetID))
	var out struct {
		ChEMBLID   string `json:"target_chembl_id"`
		PrefName   string `json:"pref_name"`
		Type       string `json:"target_type"`
		Organism   string `json:"organism"`
		Components []struct {
			Accession string `json:"accession"`
			Synonyms  []struct {
				Syn  string `json:"component_synonym"`
				Type string `json:"syn_type"`
			} `json:"target_component_synonyms"`
		} `json:"target_components"`
	}
	if _, err := c.GetJSON(ctx, "chembl", u, &out); err != nil {
		return Target{}, err
	}
	if out.ChEMBLID == "" {
		return Target{}, fmt.Errorf("biomed/chembl: target %s: %w", targetID, ErrNotFound)
	}
	t := Target{ChEMBLID: out.ChEMBLID, PrefName: out.PrefName, Type: out.Type, Organism: out.Organism,
		Evidence: Evidence{Source: "chembl", ID: out.ChEMBLID, URL: u, Quote: out.PrefName, Retrieved: time.Now().UTC()}}
	for _, comp := range out.Components {
		if comp.Accession != "" {
			t.UniProt = append(t.UniProt, comp.Accession)
		}
		for _, s := range comp.Synonyms {
			if s.Type == "GENE_SYMBOL" && s.Syn != "" {
				t.GeneSymbols = append(t.GeneSymbols, s.Syn)
			}
		}
	}
	return t, nil
}

// Activities returns measured IC50/Ki values for a compound, most potent first.
func (c *Client) Activities(ctx context.Context, chemblID string, limit int) ([]Activity, error) {
	return c.ActivitiesForTarget(ctx, chemblID, "", limit)
}

// ActivitiesForTarget is Activities restricted to one ChEMBL target ("" = any),
// so the reported potency concerns the drug's actual mechanism target.
func (c *Client) ActivitiesForTarget(ctx context.Context, chemblID, targetID string, limit int) ([]Activity, error) {
	if limit <= 0 {
		limit = 10
	}
	u := fmt.Sprintf("%s/activity.json?molecule_chembl_id=%s&standard_type__in=IC50,Ki&limit=%d&order_by=standard_value",
		chemblBase, url.QueryEscape(chemblID), limit)
	if targetID != "" {
		u += "&target_chembl_id=" + url.QueryEscape(targetID)
	}
	var out struct {
		Activities []struct {
			ID       int64        `json:"activity_id"`
			Type     string       `json:"standard_type"`
			Value    chemblNumber `json:"standard_value"`
			Units    string       `json:"standard_units"`
			PChEMBL  chemblNumber `json:"pchembl_value"`
			Target   string       `json:"target_chembl_id"`
			TargetNm string       `json:"target_pref_name"`
			Assay    string       `json:"assay_description"`
			Doc      string       `json:"document_chembl_id"`
		} `json:"activities"`
	}
	if _, err := c.GetJSON(ctx, "chembl", u, &out); err != nil {
		return nil, err
	}
	res := make([]Activity, 0, len(out.Activities))
	for _, a := range out.Activities {
		if !a.Value.ok || a.TargetNm == "Unchecked" { // "Unchecked" = ChEMBL sentinel for an unassigned target
			continue
		}
		res = append(res, Activity{
			Type: a.Type, Value: a.Value.v, Units: a.Units, PChEMBL: a.PChEMBL.floatPtr(),
			TargetChEMBLID: a.Target, TargetName: a.TargetNm, Assay: a.Assay, DocumentID: a.Doc,
			Evidence: Evidence{Source: "chembl", ID: fmt.Sprintf("activity_id:%d", a.ID), URL: u,
				Quote: fmt.Sprintf("%s %g %s vs %s (%s)", a.Type, a.Value.v, a.Units, a.TargetNm, a.Doc), Retrieved: time.Now().UTC()},
		})
	}
	return res, nil
}

// compile-time check that chemblNumber is a json.Unmarshaler.
var _ json.Unmarshaler = (*chemblNumber)(nil)
