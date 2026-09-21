package cortex

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nexus-cortex/cortex/biomed"
)

// biomedFixtures serves the recorded responses under cortex/biomed/testdata
// by URL (and, for POST, body) substring. "" as a path means network failure.
type biomedFixtures struct {
	routes map[string]string
}

func (f biomedFixtures) Do(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		body = string(b)
	}
	for key, path := range f.routes {
		urlPart, bodyPart := key, ""
		if strings.HasPrefix(key, "POST:") {
			parts := strings.SplitN(strings.TrimPrefix(key, "POST:"), "|", 2)
			urlPart = parts[0]
			if len(parts) == 2 {
				bodyPart = parts[1]
			}
		}
		if !strings.Contains(req.URL.String(), urlPart) || (bodyPart != "" && !strings.Contains(body, bodyPart)) {
			continue
		}
		if path == "" {
			return nil, errors.New("dial tcp: no route to host")
		}
		data, err := os.ReadFile(filepath.Join("biomed", "testdata", path))
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: http.Header{}}, nil
	}
	return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("{}")), Header: http.Header{}}, nil
}

func gefitinibRoutes() map[string]string {
	return map[string]string{
		"approximateTerm.json?term=gefitinib":         "rxnorm/approx_gefitinib.json",
		"rxcui/328134/properties":                     "rxnorm/props_328134.json",
		"displaynames.json":                           "rxnorm/displaynames.json",
		"molecule/search.json?q=gefitinib":            "chembl/search_gefitinib.json",
		"mechanism.json?molecule_chembl_id=CHEMBL939": "chembl/mech_CHEMBL939.json",
		"target/CHEMBL203.json":                       "chembl/target_CHEMBL203.json",
		"activity.json?molecule_chembl_id=CHEMBL939":  "chembl/act_CHEMBL939.json",
		`generic_name%3A%22gefitinib%22`:              "openfda/label_gefitinib.json",
		`POST:opentargets|entityNames:[\"target\"]`:   "opentargets/search_target.json",
		"POST:opentargets|ENSG00000146648":            "opentargets/target_EGFR.json",
	}
}

func newTestBiomedTool(t *testing.T, routes map[string]string) *BiomedTool {
	t.Helper()
	b, err := biomed.NewBridge(t.TempDir(), biomed.WithFetcher(biomedFixtures{routes}), biomed.WithThrottle(0), biomed.WithBackoff(0))
	if err != nil {
		t.Fatal(err)
	}
	return NewBiomedToolWithBridge(b)
}

func TestBiomedTool_MatchesOnlyWhenADrugIsMentioned(t *testing.T) {
	tool := newTestBiomedTool(t, gefitinibRoutes())
	if err := tool.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if tool.Name() != "biomed" {
		t.Fatalf("name = %q", tool.Name())
	}
	if !tool.Match("ce este gefitinib și la ce se folosește") {
		t.Fatal("expected match on a drug mention")
	}
	if tool.Match("salut, ce mai faci") {
		t.Fatal("must not match without a drug mention")
	}
}

func TestBiomedTool_OfflineWithoutCacheNeverMatchesAndNeverPanics(t *testing.T) {
	routes := map[string]string{}
	for k := range gefitinibRoutes() {
		routes[k] = ""
	}
	tool := newTestBiomedTool(t, routes)
	if tool.Match("ce este gefitinib") {
		t.Fatal("offline tool must stay silent")
	}
	if out, ok := tool.Execute("ce este gefitinib"); ok || out != "" {
		t.Fatalf("offline Execute must return (\"\", false), got %q %v", out, ok)
	}
}

func TestBiomedTool_ExecuteReportsSourcesInTheQuestionLanguage(t *testing.T) {
	tool := newTestBiomedTool(t, gefitinibRoutes())
	if err := tool.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	out, ok := tool.Execute("Ce este gefitinib și care e mecanismul lui?")
	if !ok {
		t.Fatal("expected an answer")
	}
	for _, want := range []string{"CHEMBL939", "openFDA", "Mecanism", "Surse", "Epidermal growth factor receptor"} {
		if !strings.Contains(out, want) {
			t.Errorf("answer missing %q:\n%s", want, out)
		}
	}
	en, ok := tool.Execute("What is gefitinib and how does it work?")
	if !ok || !strings.Contains(en, "Mechanism") || !strings.Contains(en, "Sources") {
		t.Fatalf("english answer expected, got ok=%v:\n%s", ok, en)
	}
}

func TestOrganism_RegistersBiomedToolOnlyWhenEnabled(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BiomedEnabled = false
	off := NewOrganism(cfg, rand.New(rand.NewSource(1)))
	for _, n := range off.Reasoning.ToolNames() {
		if n == "biomed" {
			t.Fatal("biomed registered although disabled")
		}
	}
	cfg.BiomedEnabled = true
	cfg.BiomedCacheDir = t.TempDir()
	on := NewOrganism(cfg, rand.New(rand.NewSource(1)))
	found := false
	for _, n := range on.Reasoning.ToolNames() {
		if n == "biomed" {
			found = true
		}
	}
	if !found {
		t.Fatalf("biomed not registered when enabled: %v", on.Reasoning.ToolNames())
	}
}
