// Package service is the native session API. Production listens on a private
// Unix socket, never a TCP port or browser origin. The model has no root access.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"

	"swypik-os/core/agent"
	"swypik-os/core/network"
	"swypik-os/core/search"
)

type Service struct {
	Agent     *agent.Manager
	Search    *search.Engine
	Workspace string
}

func SearchTool(e *search.Engine) agent.Tool {
	return agent.Tool{Spec: agent.Spec{Name: "search.query", Description: "Search the existing local web index; does not crawl or contact websites.", Arguments: `{"query":"words"}`}, Validate: func(raw json.RawMessage) error {
		var a struct {
			Query string `json:"query"`
		}
		if err := agent.DecodeObject(raw, &a, 1024); err != nil {
			return err
		}
		if a.Query == "" || len(a.Query) > 512 {
			return fmt.Errorf("invalid query")
		}
		return nil
	}, Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var a struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		r, err := e.Search(a.Query)
		if err != nil {
			return nil, err
		}
		// Agent observations are capped at 12 KiB; keep the top results.
		if len(r.Sources) > 5 {
			r.Sources = r.Sources[:5]
		}
		for i := range r.Sources {
			if len(r.Sources[i].Snippet) > 400 {
				r.Sources[i].Snippet = strings.ToValidUTF8(r.Sources[i].Snippet[:400], "")
			}
		}
		return json.Marshal(r)
	}}
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	write := r.URL.Path == "/v1/run" || r.URL.Path == "/v1/resume" || r.URL.Path == "/v1/decision" || r.URL.Path == "/v1/cancel" || r.URL.Path == "/v1/crawl"
	method := "GET"
	if write {
		method = "POST"
	}
	if r.Method != method {
		http.Error(w, "method not allowed", 405)
		return
	}
	if r.Header.Get("Origin") != "" {
		http.Error(w, "native IPC only", 403)
		return
	}
	read := func(v interface{}) bool {
		b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
		if err == nil {
			err = agent.DecodeObject(b, v, 8192)
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return false
		}
		return true
	}
	send := func(v interface{}, err error) {
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		_ = json.NewEncoder(w).Encode(v)
	}
	switch r.URL.Path {
	case "/v1/status":
		n, err := network.Inspect(r.Context())
		if err != nil {
			http.Error(w, "network inventory unavailable", 503)
			return
		}
		send(struct {
			OS      string         `json:"os"`
			UID     int            `json:"uid"`
			Network network.Status `json:"network"`
			Indexed int            `json:"indexed"`
			Run     *agent.Run     `json:"run"`
			Mode    string         `json:"mode"`
		}{runtime.GOOS, os.Getuid(), n, s.Search.Count(), s.Agent.Snapshot(), "native_pre_alpha_read_only_agent"}, nil)
	case "/v1/search":
		v, err := s.Search.Search(r.URL.Query().Get("q"))
		send(v, err)
	case "/v1/crawl":
		var a struct {
			URL     string `json:"url"`
			Pages   int    `json:"pages"`
			Consent bool   `json:"consent"`
		}
		if !read(&a) {
			return
		}
		if !a.Consent {
			http.Error(w, "explicit crawl consent required", 400)
			return
		}
		v, err := s.Search.Crawl(r.Context(), a.URL, a.Pages)
		send(v, err)
	case "/v1/run":
		var a struct {
			Goal    string `json:"goal"`
			Consent bool   `json:"consent"`
		}
		if !read(&a) {
			return
		}
		if !a.Consent {
			http.Error(w, "consent to send goal and approved metadata to Ilaria is required", 400)
			return
		}
		v, err := s.Agent.Start(a.Goal)
		send(v, err)
	case "/v1/resume":
		var a struct {
			RunID   string `json:"run_id"`
			Consent bool   `json:"consent"`
		}
		if !read(&a) {
			return
		}
		if !a.Consent {
			http.Error(w, "explicit consent to resume and send recorded observations to Ilaria is required", 400)
			return
		}
		v, err := s.Agent.Resume(a.RunID)
		send(v, err)
	case "/v1/decision":
		var a struct {
			RunID      string `json:"run_id"`
			ApprovalID string `json:"approval_id"`
			Approve    *bool  `json:"approve"`
		}
		if !read(&a) {
			return
		}
		if a.Approve == nil {
			http.Error(w, "approval must be explicit", 400)
			return
		}
		err := s.Agent.Decide(a.RunID, a.ApprovalID, *a.Approve)
		send(s.Agent.Snapshot(), err)
	case "/v1/cancel":
		var a struct {
			RunID string `json:"run_id"`
		}
		if !read(&a) {
			return
		}
		send(nil, s.Agent.Cancel(a.RunID))
	case "/v1/files":
		for _, tool := range agent.ReadOnlyTools(s.Workspace) {
			if tool.Spec.Name == "workspace.list" {
				v, err := tool.Execute(r.Context(), json.RawMessage(`{"path":"."}`))
				send(v, err)
				return
			}
		}
	default:
		http.NotFound(w, r)
	}
}
