// ilaria-serve exposes the local BitNet engine to SwypikOS. It never
// downloads models and never registers unrestricted code execution tools.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"nexus-cortex/cortex"
)

type chatRequest struct {
	Prompt  string               `json:"prompt"`
	History []cortex.ChatMessage `json:"history,omitempty"`
}
type chatResponse struct {
	Reply  string       `json:"reply"`
	Tokens int          `json:"tokens"`
	Calls  []callResult `json:"calls,omitempty"`
}
type callResult struct {
	Tool    string `json:"tool"`
	Success bool   `json:"success"`
	Result  string `json:"result"`
}
type inferFunc func(context.Context, chatRequest) (chatResponse, error)

func newHandler(infer inferFunc) http.Handler {
	gate := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fail := func(code int, msg string) {
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
		}
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "127.0.0.1" || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			fail(403, "local server-to-server requests only")
			return
		}
		if r.URL.Path == "/health" && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready", "engine": "bitnet", "default_language": "en"})
			return
		}
		if r.URL.Path != "/v1/chat" {
			fail(404, "not found")
			return
		}
		if r.Method != http.MethodPost {
			fail(405, "POST required")
			return
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			fail(415, "application/json required")
			return
		}
		var req chatRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			fail(400, "invalid request")
			return
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			fail(400, "expected one request")
			return
		}
		if strings.TrimSpace(req.Prompt) == "" || len(req.History) > 20 || len(req.History)%2 != 0 {
			fail(400, "prompt and up to 10 complete history turns required")
			return
		}
		for i, m := range req.History {
			role := "user"
			if i%2 == 1 {
				role = "assistant"
			}
			if m.Role != role {
				fail(400, "invalid history role")
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		select {
		case gate <- struct{}{}:
			defer func() { <-gate }()
		case <-ctx.Done():
			fail(503, "inference queue cancelled")
			return
		}
		res, err := infer(ctx, req)
		if err != nil {
			fail(422, err.Error())
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})
}

func main() {
	modelPath := flag.String("model", "", "BitNet NXTF model (required)")
	tokenizerPath := flag.String("tokenizer", "", "HF tokenizer.json (required)")
	adapter := flag.String("adapter", "", "LoRA export prefix, loaded before decoder construction")
	useCUDA := flag.Bool("cuda", false, "Use resident CUDA decoder (-tags gpu)")
	port := flag.Int("port", 8091, "Loopback HTTP port")
	listen := flag.String("listen", "127.0.0.1", "Listen IP; non-loopback requires TLS and ILARIA_API_TOKEN")
	tlsCert := flag.String("tls-cert", "", "TLS certificate path for authenticated cloud serving")
	tlsKey := flag.String("tls-key", "", "TLS key path for authenticated cloud serving")
	workdir := flag.String("workdir", "", "Optional read_file root; no file writes or host code execution")
	maxTokens := flag.Int("max-tokens", 256, "Maximum generated tokens per segment")
	printSystem := flag.Bool("print-system-prompt", false, "Print the serving system prompt for dataset curation and exit")
	flag.Parse()
	tools := []cortex.ChatTool{cortex.CalcChatTool{}, cortex.TimeChatTool{}, cortex.ConvertChatTool{}}
	if *workdir != "" {
		tools = append(tools, cortex.NewReadFileChatTool(*workdir))
	}
	if *printSystem {
		fmt.Println(cortex.BuildSystemPrompt(tools))
		return
	}
	if *modelPath == "" || *tokenizerPath == "" || *port < 1 || *port > 65535 || *maxTokens < 1 || *maxTokens > 4096 {
		log.Fatal("valid -model, -tokenizer, -port and -max-tokens required")
	}
	cloud := *listen != "127.0.0.1" || *tlsCert != "" || *tlsKey != ""
	if net.ParseIP(*listen) == nil {
		log.Fatal("-listen must be an IP address")
	}
	if cloud {
		if *tlsCert == "" || *tlsKey == "" {
			log.Fatal("cloud serving requires -tls-cert and -tls-key")
		}
		if _, err := cloudHandler(http.NotFoundHandler(), os.Getenv("ILARIA_API_TOKEN")); err != nil {
			log.Fatal(err)
		}
	}
	m, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		log.Fatal(err)
	}
	if *adapter != "" {
		if err = cortex.LoadBitNetLoRA(m, *adapter); err != nil {
			log.Fatal(err)
		}
	}
	tok, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
	if err != nil {
		log.Fatal(err)
	}
	var dec cortex.StepDecoder
	if *useCUDA {
		d, e := cortex.NewBitNetCUDADecoder(m)
		if e != nil {
			log.Fatal(e)
		}
		defer d.Close()
		dec = d
	} else {
		dec = cortex.NewBitNetDecoder(m)
	}
	stop := []int{m.Cfg.EOSTokenID}
	if tok.EotID() >= 0 {
		stop = append(stop, tok.EotID())
	}
	runner := cortex.NewRunner(dec, tok, stop, m.Cfg.MaxSeqLen, tools, 3, *maxTokens, io.Discard)
	h := newHandler(func(ctx context.Context, req chatRequest) (chatResponse, error) {
		r, err := runner.ConversationTurn(ctx, req.History, req.Prompt)
		if err != nil {
			return chatResponse{}, err
		}
		res := chatResponse{Reply: r.Answer, Tokens: r.Tokens}
		for _, c := range r.ToolCalls {
			res.Calls = append(res.Calls, callResult{Tool: c.Tool, Success: c.Err == nil, Result: c.Result})
		}
		return res, nil
	})
	if cloud {
		h, err = cloudHandler(h, os.Getenv("ILARIA_API_TOKEN"))
		if err != nil {
			log.Fatal(err)
		}
	}
	srv := &http.Server{Addr: net.JoinHostPort(*listen, fmt.Sprint(*port)), Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 3 * time.Minute, IdleTimeout: 30 * time.Second}
	ctx, stopSignal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if cloud {
		log.Printf("Ilaria TLS service starting at %s (authenticated)", srv.Addr)
		err = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		log.Printf("Ilaria ready at http://%s (English default)", srv.Addr)
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
