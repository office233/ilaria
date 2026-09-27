package ilaria

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Backend interface {
	Chat(context.Context, string, []Message) (string, error)
}

type LocalBackend struct {
	endpoint string
	client   *http.Client
	token    string
}

// NewCloudBackend connects to a trusted HTTPS inference endpoint. Tokens are
// provisioned at runtime, never embedded in a distributable desktop binary.
func NewCloudBackend(endpoint, token string) *LocalBackend {
	b := NewLocalBackend(endpoint)
	b.token = token
	return b
}

func NewLocalBackend(endpoint string) *LocalBackend {
	return &LocalBackend{endpoint: strings.TrimRight(endpoint, "/"), client: &http.Client{
		Timeout:       130 * time.Second,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (b *LocalBackend) Chat(ctx context.Context, prompt string, history []Message) (string, error) {
	u, err := url.Parse(b.endpoint)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Hostname() == "" {
		return "", fmt.Errorf("invalid Ilaria endpoint")
	}
	local := u.Scheme == "http" && u.Hostname() == "127.0.0.1" && b.token == ""
	cloud := u.Scheme == "https" && len(b.token) >= 32 && strings.TrimSpace(b.token) == b.token
	if !local && !cloud {
		return "", fmt.Errorf("Ilaria requires loopback HTTP or authenticated HTTPS")
	}
	type turn struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	turns := make([]turn, 0, len(history))
	if len(history)%2 != 0 {
		return "", fmt.Errorf("Ilaria history must contain complete turns")
	}
	if len(history) > 20 {
		history = history[len(history)-20:]
	}
	for i, m := range history {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		if (i%2 == 0 && m.Sender != "user") || (i%2 == 1 && m.Sender != "ilaria") {
			return "", fmt.Errorf("Ilaria history must alternate user and assistant")
		}
		turns = append(turns, turn{role, m.Text})
	}
	request := struct {
		Prompt  string `json:"prompt"`
		History []turn `json:"history,omitempty"`
	}{prompt, turns}
	var body []byte
	for {
		body, err = json.Marshal(request)
		if err != nil {
			return "", err
		}
		if len(body) <= 64*1024 {
			break
		}
		if len(request.History) == 0 {
			return "", fmt.Errorf("prompt exceeds Ilaria's 64 KiB request limit")
		}
		// Remove complete oldest turns, measured after JSON escaping. Never
		// truncate the user's current prompt or send a partial conversation pair.
		request.History = request.History[2:]
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint+"/v1/chat", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if cloud {
		req.Header.Set("Authorization", "Bearer "+b.token)
	}
	res, err := b.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach Ilaria service: %w", err)
	}
	defer res.Body.Close()
	var payload struct {
		Reply string `json:"reply"`
		Error string `json:"error"`
	}
	response, err := io.ReadAll(io.LimitReader(res.Body, 128*1024+1))
	if err != nil {
		return "", fmt.Errorf("cannot read Ilaria response: %w", err)
	}
	if len(response) > 128*1024 {
		return "", fmt.Errorf("Ilaria response exceeds 128 KiB limit")
	}
	if err = json.Unmarshal(response, &payload); err != nil {
		return "", fmt.Errorf("invalid Ilaria response: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Ilaria HTTP %d: %s", res.StatusCode, payload.Error)
	}
	if strings.TrimSpace(payload.Reply) == "" {
		return "", fmt.Errorf("Ilaria returned an empty answer")
	}
	return payload.Reply, nil
}
