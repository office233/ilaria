package main

import (
	"bufio"
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

const (
	maxCoreServerLine     = 2*coreir.MaxBytes + (64 << 10)
	maxCoreServerPrograms = 256
)

type coreServerRequest struct {
	ID      string   `json:"id"`
	Action  string   `json:"action"`
	Args    []string `json:"args,omitempty"`
	Source  string   `json:"source,omitempty"`
	File    string   `json:"file,omitempty"`
	Entry   string   `json:"entry,omitempty"`
	Profile string   `json:"profile,omitempty"`
	Values  []string `json:"values,omitempty"`
	Steps   int      `json:"steps,omitempty"`
}

type coreServerResponse struct {
	ID      string `json:"id,omitempty"`
	Status  string `json:"status"`
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
	Warning string `json:"warning,omitempty"`
}

type serverOutput struct {
	strings.Builder
	warning string
}

func (s *serverOutput) SetWarning(w string) {
	s.warning = w
}

type coreBuildFunc func([]string, io.Writer) error
type coreCommandFunc func(string, []string, io.Writer) error

type cachedCoreProgram struct {
	hash   [32]byte
	entry  string
	exe    *coreir.Executable
	params []coreir.Parameter
}

type cachedCoreProgramEntry struct {
	key     string
	program cachedCoreProgram
}

type coreServerRuntime struct {
	programs map[string]*list.Element
	order    *list.List
}

func newCoreServerRuntime() *coreServerRuntime {
	return &coreServerRuntime{
		programs: make(map[string]*list.Element),
		order:    list.New(),
	}
}

func (r *coreServerRuntime) eval(request coreServerRequest) (string, error) {
	if request.Source == "" {
		return "", fmt.Errorf("eval requires source")
	}
	if len(request.Source) > coreir.MaxBytes {
		return "", fmt.Errorf("eval source exceeds 1 MiB")
	}
	entry := request.Entry
	if entry == "" {
		entry = "main"
	}
	profile := request.Profile
	if profile == "" {
		profile = "turbo"
	}
	if profile != "safe" && profile != "fast" && profile != "turbo" {
		return "", fmt.Errorf("eval profile must be safe, fast or turbo")
	}
	steps := request.Steps
	if steps == 0 {
		steps = 100000
	}
	if steps < 1 || steps > coreir.MaxFuel {
		return "", fmt.Errorf("eval steps must be 1..%d", coreir.MaxFuel)
	}
	filename := request.File
	if filename == "" {
		filename = "<core-server>"
	}
	hash := sha256.Sum256([]byte(request.Source))
	cacheKey := filename + "\x00" + entry + "\x00" + profile
	elem, ok := r.programs[cacheKey]
	var cached cachedCoreProgram
	if ok {
		cached = elem.Value.(*cachedCoreProgramEntry).program
	}
	if !ok || cached.hash != hash {
		p, err := swyplang.ParseCore(filename, request.Source)
		if err != nil {
			return "", err
		}
		m, err := p.CoreIR(entry)
		if err != nil {
			return "", err
		}
		if profile != "safe" {
			m, _, err = coreir.Optimize(m)
			if err != nil {
				return "", err
			}
		}
		exe, err := coreir.Prepare(m)
		if err != nil {
			return "", err
		}
		params, _, err := exe.Parameters(entry)
		if err != nil {
			return "", err
		}
		cached = cachedCoreProgram{hash: hash, entry: entry, exe: exe, params: params}
		if ok {
			elem.Value = &cachedCoreProgramEntry{key: cacheKey, program: cached}
			r.order.MoveToFront(elem)
		} else {
			if r.order.Len() >= maxCoreServerPrograms {
				oldest := r.order.Back()
				if oldest != nil {
					oldEntry := oldest.Value.(*cachedCoreProgramEntry)
					delete(r.programs, oldEntry.key)
					r.order.Remove(oldest)
				}
			}
			newElem := r.order.PushFront(&cachedCoreProgramEntry{key: cacheKey, program: cached})
			r.programs[cacheKey] = newElem
		}
	} else {
		r.order.MoveToFront(elem)
	}
	if len(request.Values) != len(cached.params) {
		return "", fmt.Errorf("entry %s expects %d typed arguments", entry, len(cached.params))
	}
	var smallValues [16]coreir.Value
	values := smallValues[:len(cached.params)]
	for i, param := range cached.params {
		value, err := coreir.ParseValue(param.Type, request.Values[i])
		if err != nil {
			return "", err
		}
		values[i] = value
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var (
		result coreir.RunResult
		err    error
	)
	switch profile {
	case "turbo":
		result, err = cached.exe.RunTurbo(ctx, entry, values, steps)
	case "fast":
		result, err = cached.exe.RunFast(ctx, entry, values, steps)
	default:
		result, err = cached.exe.Run(ctx, entry, values, steps)
	}
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// coreServer keeps the compiler alive for IDE/LSP/build systems. It is
// deliberately stdin/stdout only: no listening socket, no ambient network
// authority and one bounded JSON request per line.
func coreServer(input io.Reader, output io.Writer, build coreBuildFunc, core coreCommandFunc) error {
	reader := bufio.NewReader(input)
	enc := json.NewEncoder(output)
	runtime := newCoreServerRuntime()
	for {
		var lineBuf bytes.Buffer
		oversized := false
		for {
			chunk, isPrefix, err := reader.ReadLine()
			if err != nil {
				if err == io.EOF {
					if lineBuf.Len() == 0 && !oversized {
						return nil
					}
					break
				}
				return err
			}
			if oversized {
				if !isPrefix {
					break
				}
				continue
			}
			if lineBuf.Len()+len(chunk) > maxCoreServerLine {
				oversized = true
				lineBuf.Reset()
				if !isPrefix {
					break
				}
				continue
			}
			lineBuf.Write(chunk)
			if !isPrefix {
				break
			}
		}
		if oversized {
			if writeErr := enc.Encode(coreServerResponse{Status: "error", Error: "request line exceeds maximum size"}); writeErr != nil {
				return writeErr
			}
			continue
		}
		line := strings.TrimSpace(lineBuf.String())
		if line == "" {
			continue
		}
		var request coreServerRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			if writeErr := enc.Encode(coreServerResponse{Status: "error", Error: "invalid request JSON"}); writeErr != nil {
				return writeErr
			}
			continue
		}
		if request.ID == "" {
			if err := enc.Encode(coreServerResponse{Status: "error", Error: "request id is required"}); err != nil {
				return err
			}
			continue
		}
		switch request.Action {
		case "shutdown":
			return enc.Encode(coreServerResponse{ID: request.ID, Status: "bye"})
		case "build":
			var buildOut serverOutput
			err := build(request.Args, &buildOut)
			response := coreServerResponse{
				ID:      request.ID,
				Status:  "ok",
				Output:  strings.TrimSpace(buildOut.String()),
				Warning: buildOut.warning,
			}
			if err != nil {
				response.Status = "error"
				response.Error = err.Error()
			}
			if err := enc.Encode(response); err != nil {
				return err
			}
		case "run", "check":
			kind := "core-run"
			if request.Action == "check" {
				kind = "ir"
			}
			var commandOut strings.Builder
			err := core(kind, request.Args, &commandOut)
			response := coreServerResponse{ID: request.ID, Status: "ok", Output: strings.TrimSpace(commandOut.String())}
			if err != nil {
				response.Status = "error"
				response.Error = err.Error()
			}
			if err := enc.Encode(response); err != nil {
				return err
			}
		case "eval":
			value, err := runtime.eval(request)
			response := coreServerResponse{ID: request.ID, Status: "ok", Output: value}
			if err != nil {
				response.Status = "error"
				response.Error = err.Error()
			}
			if err := enc.Encode(response); err != nil {
				return err
			}
		default:
			if err := enc.Encode(coreServerResponse{ID: request.ID, Status: "error", Error: fmt.Sprintf("unknown action %q", request.Action)}); err != nil {
				return err
			}
		}
	}
}
