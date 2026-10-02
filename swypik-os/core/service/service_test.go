package service

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"swypik-os/core/agent"
	"swypik-os/core/search"
	"testing"
)

type noModel struct{}

func (noModel) Next(context.Context, string, []agent.Spec, []agent.Observation) (agent.Decision, error) {
	return agent.Decision{Action: "finish", Summary: "test fixture"}, nil
}
func TestNativeConsentAndOrigin(t *testing.T) {
	e := search.NewEngine()
	m, err := agent.New(noModel{}, []agent.Tool{SearchTool(e)}, agent.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s := &Service{Agent: m, Search: e, Workspace: t.TempDir()}
	for _, tc := range []struct {
		path, body, origin string
		want               int
	}{{"/v1/run", `{"goal":"test","consent":false}`, "", 400}, {"/v1/run", `{"goal":"test","consent":true}`, "http://evil.invalid", 403}, {"/v1/run", `{"goal":"test","goal":"override","consent":true}`, "", 400}, {"/v1/crawl", `{"url":"https://example.org/","pages":1,"consent":false}`, "", 400}} {
		r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s: %d", tc.path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/v1/search?q=hello", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result search.Result
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Sources) != 0 {
		t.Fatal("invalid search")
	}
}
