// mockteacher — a local stand-in for an OpenAI-compatible chat endpoint.
//
// Used to validate the distill -> ingest -> learn chain end to end without
// spending API quota (and while the real key is paused). It answers with
// deterministic canned facts so the resulting corpus is checkable.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

type chatReq struct {
	Model    string `json:"model"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

// canned answers keyed by a substring of the question
var answers = map[string]string{
	"capital of france":  "Paris.",
	"capital of japan":   "Tokyo.",
	"capital of italy":   "Rome.",
	"15 + 27":            "42.",
	"relativity":         "Albert Einstein developed the theory of relativity.",
	"water boil":         "Water boils at 100 degrees Celsius at sea level.",
	"largest planet":     "Jupiter is the largest planet in the solar system.",
	"photosynthesis":     "Photosynthesis is how plants convert light into chemical energy.",
	"speed of light":     "The speed of light is about 300,000 kilometres per second.",
	"who wrote hamlet":   "William Shakespeare wrote Hamlet.",
}

func main() {
	http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		q := ""
		for _, m := range req.Messages {
			if m.Role == "user" {
				q = strings.ToLower(m.Content)
			}
		}
		reply := "I do not know."
		for k, v := range answers {
			if strings.Contains(q, k) {
				reply = v
				break
			}
		}
		resp := map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"role": "assistant", "content": reply}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	fmt.Println("mockteacher listening on :877")
	log.Fatal(http.ListenAndServe("127.0.0.1:877", nil))
}
