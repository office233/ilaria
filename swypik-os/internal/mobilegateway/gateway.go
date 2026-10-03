// Package mobilegateway owns admission, cancellation and bounded provider transport.
// It forwards canonical Myriad records; it owns no model or P2P implementation.
package mobilegateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"swypik-os/core/resource"
	"swypik-os/generated/myriad"
	"swypik-os/internal/planprocess"
)

const MaxBytes = 65536
const MaxSafeInteger uint64 = 9007199254740991

var identity = regexp.MustCompile("^[A-Za-z0-9_.:-]{1,128}$")
var digest = regexp.MustCompile("^[0-9a-f]{64}$")
var ErrAdmission = errors.New("gateway admission denied")
var ErrCleanup = errors.New("owned worker cleanup unverified")

type Principal struct{ UserID string }
type Authenticator interface {
	Authenticate(context.Context, string) (Principal, error)
}
type Provider interface {
	// Infer must return only after its owned worker is stopped and resource handles closed.
	Infer(context.Context, myriad.CorticalRequest) (myriad.CorticalResponse, error)
}
type Config struct {
	Authenticator Authenticator
	Provider      Provider
	MaxConcurrent int
	MaxRecords    int
	CancelWait    time.Duration
	AllowCanary   bool
}
type execution struct {
	requestHash [32]byte
	cancel      context.CancelFunc
	done        chan struct{}
	status      string
	expires     time.Time
}
type Gateway struct {
	config     Config
	mu         sync.Mutex
	runs       map[string]*execution
	slots      chan struct{}
	admissions chan struct{}
	closed     bool
}

func New(config Config) (*Gateway, error) {
	if config.Authenticator == nil || config.Provider == nil || config.MaxConcurrent < 1 ||
		config.MaxConcurrent > 16 || config.MaxRecords < config.MaxConcurrent || config.MaxRecords > 1024 ||
		config.CancelWait <= 0 || config.CancelWait > 2*time.Second {
		return nil, ErrAdmission
	}
	return &Gateway{config: config, runs: make(map[string]*execution), slots: make(chan struct{}, config.MaxConcurrent), admissions: make(chan struct{}, config.MaxConcurrent+2)}, nil
}

// DecodeCanonical rejects aliases, missing/null fields, duplicates, lossy strings,
// trailing documents and unsafe integers before decoding generated Myriad DTOs.
func DecodeCanonical(raw []byte, destination any) error {
	if len(raw) > MaxBytes || !utf8.Valid(raw) {
		return errors.New("JSON frame bound/UTF8")
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '"' {
			continue
		}
		i++
		for i < len(raw) && raw[i] != '"' {
			if raw[i] != '\\' {
				i++
				continue
			}
			i++
			if i >= len(raw) {
				return errors.New("JSON escape")
			}
			if raw[i] == 'u' {
				if i+4 >= len(raw) {
					return errors.New("unicode escape")
				}
				v, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
				if e != nil {
					return e
				}
				if v >= 0xdc00 && v <= 0xdfff {
					return errors.New("unpaired surrogate")
				}
				if v >= 0xd800 && v <= 0xdbff {
					if i+10 >= len(raw) || raw[i+5] != '\\' || raw[i+6] != 'u' {
						return errors.New("unpaired surrogate")
					}
					low, e := strconv.ParseUint(string(raw[i+7:i+11]), 16, 16)
					if e != nil || low < 0xdc00 || low > 0xdfff {
						return errors.New("unpaired surrogate")
					}
					i += 6
				}
				i += 4
			}
			i++
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 16 {
			return nil, errors.New("JSON depth")
		}
		t, e := d.Token()
		if e != nil {
			return nil, e
		}
		if delim, ok := t.(json.Delim); ok {
			if delim == '{' {
				m := map[string]any{}
				for d.More() {
					k, e := d.Token()
					if e != nil {
						return nil, e
					}
					key, ok := k.(string)
					if !ok {
						return nil, errors.New("JSON key")
					}
					if _, ok = m[key]; ok {
						return nil, errors.New("duplicate field")
					}
					v, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					m[key] = v
				}
				end, e := d.Token()
				if e != nil || end != json.Delim('}') {
					return nil, errors.New("JSON object")
				}
				return m, nil
			}
			if delim == '[' {
				a := []any{}
				for d.More() {
					v, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					if len(a) >= 32 {
						return nil, errors.New("array bound")
					}
					a = append(a, v)
				}
				end, e := d.Token()
				if e != nil || end != json.Delim(']') {
					return nil, errors.New("JSON array")
				}
				return a, nil
			}
			return nil, errors.New("JSON delimiter")
		}
		if n, ok := t.(json.Number); ok {
			v, e := strconv.ParseInt(string(n), 10, 64)
			if e != nil || v > int64(MaxSafeInteger) || v < -int64(MaxSafeInteger) {
				return nil, errors.New("unsafe integer")
			}
		}
		return t, nil
	}
	value, e := read(0)
	if e != nil {
		return e
	}
	if _, e = d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	target := reflect.TypeOf(destination)
	if target == nil || target.Kind() != reflect.Pointer || reflect.ValueOf(destination).IsNil() {
		return errors.New("decode destination")
	}
	var shape func(any, reflect.Type) error
	shape = func(v any, t reflect.Type) error {
		switch t.Kind() {
		case reflect.Struct:
			m, ok := v.(map[string]any)
			if !ok {
				return errors.New("object required")
			}
			if len(m) != t.NumField() {
				return errors.New("canonical field count")
			}
			for i := 0; i < t.NumField(); i++ {
				f := t.Field(i)
				key := strings.Split(f.Tag.Get("json"), ",")[0]
				x, ok := m[key]
				if !ok {
					return errors.New("missing/case-alias field")
				}
				if e := shape(x, f.Type); e != nil {
					return e
				}
			}
		case reflect.Slice:
			a, ok := v.([]any)
			if !ok {
				return errors.New("nonnull array required")
			}
			for _, x := range a {
				if e := shape(x, t.Elem()); e != nil {
					return e
				}
			}
		case reflect.Map:
			m, ok := v.(map[string]any)
			if !ok || len(m) > 32 {
				return errors.New("nonnull bounded map required")
			}
			for k, x := range m {
				if len(k) > 128 {
					return errors.New("map key bound")
				}
				if e := shape(x, t.Elem()); e != nil {
					return e
				}
			}
		case reflect.String:
			s, ok := v.(string)
			if !ok || len(s) > 4096 {
				return errors.New("bounded string required")
			}
		case reflect.Uint64, reflect.Int64:
			n, ok := v.(json.Number)
			if !ok {
				return errors.New("integer required")
			}
			i, e := strconv.ParseInt(string(n), 10, 64)
			if e != nil || (t.Kind() == reflect.Uint64 && i < 0) {
				return errors.New("integer range")
			}
		case reflect.Bool:
			if _, ok := v.(bool); !ok {
				return errors.New("boolean required")
			}
		case reflect.Interface:
			if v != nil {
				if s, ok := v.(string); !ok || len(s) > 4096 {
					return errors.New("nullable profile string required")
				}
			}
		default:
			return errors.New("unsupported JSON shape")
		}
		return nil
	}
	if e := shape(value, target.Elem()); e != nil {
		return e
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	return d.Decode(destination)
}
func validateRequest(r myriad.CorticalRequest, user string, control bool) error {
	now := time.Now().UnixMilli()
	if r.ProtocolVersion != 1 || !identity.MatchString(r.TaskID) || r.Initiator != user || !identity.MatchString(user) ||
		r.Modality != "text" || r.RequestedRole != "inference" || r.DomainSignature != "general" ||
		(r.PrivacyClass != "LOCAL_PRIVATE" && r.PrivacyClass != "PUBLIC") || r.Goal == "" || len(r.Goal) > 4096 ||
		r.ComputeBudget < 1 || r.ComputeBudget > 16 || r.ConfidenceRequirement > 1000000 ||
		r.DeadlineUnixMS > now+30000 || (!control && r.DeadlineUnixMS <= now) || (control && r.DeadlineUnixMS < now-60000) ||
		r.ParentTaskID != "" || r.WorkingMemorySummary != "" || len(r.EvidenceRefs) != 0 || len(r.HippocampusRefs) != 0 || len(r.ToolObservations) != 0 ||
		r.DesiredOutputSchema != "CorticalResponse" || !reflect.DeepEqual(r.Constraints, []string{"no_training", "no_tools"}) {
		return ErrAdmission
	}
	return nil
}
func validateResponse(r myriad.CorticalResponse, request myriad.CorticalRequest, allowCanary bool) error {
	encoded, e := json.Marshal(r)
	if e != nil {
		return e
	}
	var checked myriad.CorticalResponse
	if e = DecodeCanonical(encoded, &checked); e != nil {
		return e
	}
	m := r.RuntimeMetrics
	if r.ProtocolVersion != 1 || r.TaskID != request.TaskID || r.ExpertID != "IMC" ||
		r.ConfidencePPM > 1000000 || r.UncertaintyPPM > 1000000 || r.ComputeCost < 1 || r.ComputeCost > request.ComputeBudget ||
		r.ProposedSwypPlan != "" || r.LatentSummary != "" || m["execution_status"] != "succeeded" || m["training"] != "unavailable" ||
		(m["canary"] != "false" && m["canary"] != "true") || (!allowCanary && m["canary"] == "true") ||
		r.Hypothesis == "" || !digest.MatchString(m["model_hash"]) || !digest.MatchString(m["tokenizer_hash"]) ||
		!digest.MatchString(m["config_hash"]) || !digest.MatchString(m["canonical_source_hash"]) ||
		r.ExpertVersion != "imc-v1:"+m["config_hash"] {
		return errors.New("provider provenance/capability")
	}
	for _, k := range []string{"forward_passes", "output_tokens", "input_tokens", "wall_ns", "cpu_ns"} {
		value, e := strconv.ParseUint(m[k], 10, 64)
		if e != nil || value > MaxSafeInteger {
			return errors.New("provider metric")
		}
		if (k == "forward_passes" || k == "output_tokens") && (value != r.ComputeCost) {
			return errors.New("provider compute correlation")
		}
	}
	if !reflect.DeepEqual(r.EvidenceRefs, []string{"model:sha256:" + m["model_hash"]}) {
		return errors.New("provider evidence")
	}
	return nil
}
func controlResponse(task, status string) myriad.CorticalResponse {
	return myriad.CorticalResponse{ProtocolVersion: 1, TaskID: task, ExpertID: "GatewayControl", ExpertVersion: "gateway-v1",
		Claims: []string{}, EvidenceRefs: []string{}, Contradictions: []string{}, UncertaintyPPM: 1000000,
		NextExpertSuggestions: []string{}, VerificationRequirements: []string{}, RuntimeMetrics: map[string]string{"execution_status": status, "training": "unavailable", "energy_joules": "unmeasured"}}
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	raw, e := json.Marshal(value)
	if e != nil || len(raw) > MaxBytes {
		http.Error(w, "response_bound", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil {
		http.Error(w, "https_required", http.StatusBadRequest)
		return
	}
	if r.Method != "POST" || (r.URL.Path != "/api/ilaria/infer" && r.URL.Path != "/api/ilaria/cancel" && r.URL.Path != "/api/ilaria/status") || r.URL.RawQuery != "" {
		http.Error(w, "unsupported_route", http.StatusNotFound)
		return
	}
	media, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || media != "application/json" {
		http.Error(w, "json_required", 400)
		return
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || !digest.MatchString(strings.TrimPrefix(authorization, "Bearer ")) {
		http.Error(w, "unauthorized", 401)
		return
	}
	token := strings.TrimPrefix(authorization, "Bearer ")
	select {
	case g.admissions <- struct{}{}:
		defer func() { <-g.admissions }()
	default:
		http.Error(w, "admission_backpressure", 429)
		return
	}
	if r.ContentLength > MaxBytes {
		http.Error(w, "request_bound", 413)
		return
	}
	if e := http.NewResponseController(w).SetReadDeadline(time.Now().Add(3 * time.Second)); e != nil {
		http.Error(w, "bounded_body_unavailable", 503)
		return
	}
	authContext, authCancel := context.WithTimeout(r.Context(), 2*time.Second)
	principal, e := g.config.Authenticator.Authenticate(authContext, token)
	authCancel()
	if e != nil || !identity.MatchString(principal.UserID) {
		http.Error(w, "unauthorized", 401)
		return
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBytes))
	_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
	if e != nil {
		http.Error(w, "request_bound", 413)
		return
	}
	var request myriad.CorticalRequest
	control := r.URL.Path != "/api/ilaria/infer"
	if e = DecodeCanonical(raw, &request); e != nil || validateRequest(request, principal.UserID, control) != nil {
		http.Error(w, "invalid_contract", 400)
		return
	}
	normalized, _ := json.Marshal(request)
	hash := sha256.Sum256(normalized)
	session := sha256.Sum256([]byte(token))
	key := principal.UserID + ":" + hex.EncodeToString(session[:]) + ":" + request.TaskID
	g.mu.Lock()
	if g.closed && !control {
		g.mu.Unlock()
		http.Error(w, "gateway_closed", 503)
		return
	}
	now := time.Now()
	for k, v := range g.runs {
		select {
		case <-v.done:
			if now.After(v.expires) {
				delete(g.runs, k)
			}
		default:
		}
	}
	existing := g.runs[key]
	if existing != nil && existing.requestHash != hash {
		g.mu.Unlock()
		http.Error(w, "task_conflict", 409)
		return
	}
	if control {
		if existing == nil {
			if r.URL.Path == "/api/ilaria/status" {
				g.mu.Unlock()
				writeJSON(w, 200, controlResponse(request.TaskID, "unknown"))
				return
			}
			if len(g.runs) >= g.config.MaxRecords {
				g.mu.Unlock()
				http.Error(w, "backpressure", 429)
				return
			}
			done := make(chan struct{})
			close(done)
			existing = &execution{requestHash: hash, done: done, status: "stopped", expires: now.Add(60 * time.Second)}
			g.runs[key] = existing
		}
		if r.URL.Path == "/api/ilaria/cancel" && existing.cancel != nil {
			existing.cancel()
		}
		done := existing.done
		status := existing.status
		g.mu.Unlock()
		if r.URL.Path == "/api/ilaria/cancel" {
			timer := time.NewTimer(g.config.CancelWait)
			defer timer.Stop()
			select {
			case <-done:
				g.mu.Lock()
				status = existing.status
				g.mu.Unlock()
			case <-timer.C:
				status = "uncertain"
			case <-r.Context().Done():
				return
			}
		}
		writeJSON(w, 200, controlResponse(request.TaskID, status))
		return
	}
	if existing != nil {
		g.mu.Unlock()
		http.Error(w, "replay_or_cancelled", 409)
		return
	}
	if len(g.runs) >= g.config.MaxRecords {
		g.mu.Unlock()
		http.Error(w, "backpressure", 429)
		return
	}
	select {
	case g.slots <- struct{}{}:
	default:
		g.mu.Unlock()
		http.Error(w, "backpressure", 429)
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.UnixMilli(request.DeadlineUnixMS))
	run := &execution{requestHash: hash, cancel: cancel, done: make(chan struct{}), status: "running", expires: now.Add(60 * time.Second)}
	g.runs[key] = run
	g.mu.Unlock()
	host, _ := resource.NewProcessSampler(os.Getpid())
	var hostStart resource.ProcessUsage
	if host != nil {
		hostStart, _ = host.Sample()
	}
	response, err := g.config.Provider.Infer(ctx, request)
	if host != nil {
		if usage, sampleErr := host.Sample(); sampleErr == nil && response.RuntimeMetrics != nil {
			response.RuntimeMetrics["gateway_process_cpu_delta_ns"] = strconv.FormatInt((usage.CPUTime - hostStart.CPUTime).Nanoseconds(), 10)
			response.RuntimeMetrics["gateway_process_peak_rss_bytes"] = strconv.FormatUint(usage.PeakRSSBytes, 10)
		}
		_ = host.Close()
	}
	contextErr := ctx.Err()
	cancel()
	if err == nil && contextErr == nil {
		err = validateResponse(response, request, g.config.AllowCanary)
	}
	g.mu.Lock()
	if errors.Is(err, ErrCleanup) {
		// A provider cleanup failure means the owned worker's state is unknown.
		// Quarantine the gateway before releasing the run so no later request can
		// start another inference against potentially live resources.
		g.closed = true
		run.status = "uncertain"
	} else if contextErr != nil {
		run.status = "stopped"
	} else if err != nil {
		run.status = "failed"
	} else {
		run.status = "succeeded"
	}
	run.cancel = nil
	close(run.done)
	g.mu.Unlock()
	<-g.slots
	if contextErr != nil {
		writeJSON(w, 409, controlResponse(request.TaskID, run.status))
		return
	}
	if err != nil {
		http.Error(w, fmt.Sprintf("provider_failed: %v", err), 503)
		return
	}
	writeJSON(w, 200, response)
}

// Close refuses new admission and waits for actual provider teardown; a timeout
// is an unverified stop, never a successful receipt.
func (g *Gateway) Close(ctx context.Context) error {
	if ctx == nil {
		return ErrCleanup
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	g.mu.Lock()
	g.closed = true
	waits := make([]*execution, 0, len(g.runs))
	for _, run := range g.runs {
		if run.cancel != nil {
			run.cancel()
		}
		waits = append(waits, run)
	}
	g.mu.Unlock()
	for _, run := range waits {
		select {
		case <-run.done:
		case <-ctx.Done():
			return ErrCleanup
		}
		g.mu.Lock()
		uncertain := run.status == "uncertain"
		g.mu.Unlock()
		if uncertain {
			return ErrCleanup
		}
	}
	return nil
}

// BackendAuthenticator delegates bearer validation to the approved HTTPS backend,
// never JWT-decodes or treats an app-shipped secret as identity.
type BackendAuthenticator struct {
	origin string
	client *http.Client
}

func NewBackendAuthenticator(origin string, client *http.Client) (*BackendAuthenticator, error) {
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") {
		return nil, ErrAdmission
	}
	if client == nil {
		client = &http.Client{}
	}
	clone := *client
	clone.Timeout = 2 * time.Second
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &BackendAuthenticator{origin: strings.TrimSuffix(origin, "/"), client: &clone}, nil
}
func (a *BackendAuthenticator) Authenticate(ctx context.Context, token string) (Principal, error) {
	request, e := http.NewRequestWithContext(ctx, "GET", a.origin+"/api/auth/me", nil)
	if e != nil {
		return Principal{}, ErrAdmission
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	response, e := a.client.Do(request)
	if e != nil {
		return Principal{}, ErrAdmission
	}
	defer response.Body.Close()
	media, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != 200 || mediaErr != nil || media != "application/json" {
		return Principal{}, ErrAdmission
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, MaxBytes+1))
	if e != nil || len(raw) > MaxBytes {
		return Principal{}, ErrAdmission
	}
	var profile struct {
		OK   bool `json:"ok"`
		User struct {
			UserID      string `json:"userId"`
			Role        string `json:"role"`
			Email       any    `json:"email"`
			DisplayName any    `json:"displayName"`
		} `json:"user"`
	}
	// Backend profile permits documented nullable display fields; decode exact
	// identity keys separately rather than applying the nonnull Myriad DTO policy.
	if e = DecodeCanonical(raw, &profile); e != nil || !profile.OK || !identity.MatchString(profile.User.UserID) {
		return Principal{}, ErrAdmission
	}
	if profile.User.Role != "shopper" && profile.User.Role != "creator" && profile.User.Role != "seller" && profile.User.Role != "admin" {
		return Principal{}, ErrAdmission
	}
	return Principal{UserID: profile.User.UserID}, nil
}

type ProcessProvider struct {
	Process  planprocess.Config
	Limits   planprocess.Limits
	CPULimit time.Duration
	// Nonblocking lifecycle observation for host conformance tests. No guest input.
	started chan<- struct{}
}

func (p ProcessProvider) Infer(ctx context.Context, request myriad.CorticalRequest) (result myriad.CorticalResponse, returned error) {
	if !filepath.IsAbs(p.Process.Executable) || p.CPULimit <= 0 {
		return result, ErrAdmission
	}
	group, e := planprocess.OpenGroup(p.Limits)
	if e != nil {
		return result, e
	}
	defer func() {
		if cleanup := group.Close(); cleanup != nil {
			returned = errors.Join(returned, ErrCleanup, cleanup)
		}
	}()
	process, e := group.Start(ctx, p.Process)
	if e != nil {
		return result, e
	}
	defer process.Close()
	if p.started != nil {
		select {
		case p.started <- struct{}{}:
		default:
		}
	}
	stop := process.Monitor(ctx, p.CPULimit, p.Limits.MemoryBytes, 50*time.Millisecond)
	if e = process.SendJSON(ctx, request); e != nil {
		_ = stop()
		return result, e
	}
	raw, e := process.ReadLine(ctx)
	if e != nil {
		_ = stop()
		return result, e
	}
	if e = DecodeCanonical(raw, &result); e != nil {
		_ = stop()
		return result, e
	}
	if e = process.Wait(ctx); e != nil {
		_ = stop()
		return result, e
	}
	if e = stop(); e != nil {
		return result, e
	}
	usage, e := process.Usage()
	if e != nil {
		return result, e
	}
	result.RuntimeMetrics["worker_cpu_ns"] = strconv.FormatInt(usage.CPUTime.Nanoseconds(), 10)
	result.RuntimeMetrics["worker_peak_rss_bytes"] = strconv.FormatUint(usage.PeakRSSBytes, 10)
	result.RuntimeMetrics["containment"] = group.Mechanism()
	return result, nil
}
