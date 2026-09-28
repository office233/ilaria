package main

// swyp-forge builds verified Swyp repair trajectories for LoRA training.
//
// For every TRAIN task in swyp/examples/swyp/tasks/tasks.jsonl it re-verifies
// the reference (must be exhaustive), mutates it at one site at a time, keeps
// only mutants for which `swyp judge` returns a real counterexample, and emits
// rows in the exact prompt text of cmd/ilaria-swyp's loop (cortex.SwypFirstPrompt
// and cortex.SwypRepairPrompt, system prompt cortex.BuildSystemPrompt(nil)):
//
//	direct: system, user <first prompt>, assistant <reference>
//	repair: system, user <repair prompt quoting the mutant and the exact verdict>, assistant <reference>
//	model:  the same two shapes built from replies the model itself wrote and the
//	        verifier accepted (-model-report, from an ilaria-swyp -split train run)
//
// The wrong code only ever appears inside a user prompt: forge.tool_data trains
// on every assistant message, so an assistant turn holding the rejected code
// would teach the model to write it. Held-out tasks are refused outright.
//
//	go run ./cmd/swyp-forge -swyp "D:\nexus\swyp\bin\swyp.exe" \
//	    -tasks swyp/examples/swyp/tasks/tasks.jsonl -out forge/colab/swyp-forge-examples-v1
import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	cortex "ilaria/cortex"
)

type task struct {
	ID        string          `json:"id"`
	Tier      string          `json:"tier"`
	Split     string          `json:"split"`
	Task      string          `json:"task"`
	Contract  json.RawMessage `json:"contract"`
	Reference string          `json:"reference"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type row struct {
	Language string    `json:"language"`
	Source   string    `json:"source"`
	TaskID   string    `json:"task_id"`
	Tier     string    `json:"tier"`
	Kind     string    `json:"kind"`
	Op       string    `json:"op,omitempty"`
	Verdict  string    `json:"verdict,omitempty"`
	Messages []message `json:"messages"`
}

type verifier func(ctx context.Context, source string, contract json.RawMessage) (cortex.SwypVerdict, error)

type stats struct {
	MutantsTried   int            `json:"mutants_tried"`
	MutantStatuses map[string]int `json:"mutant_statuses"`
	KeptByOp       map[string]int `json:"kept_by_op"`
	SyntaxTried    int            `json:"syntax_mutants_tried"`
	SyntaxStatuses map[string]int `json:"syntax_mutant_statuses"`
	ModelRows      int            `json:"model_rows"`
	ModelRejected  int            `json:"model_rejected"`
}

func loadTasks(path string) ([]task, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []task
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		var t task
		if err := json.Unmarshal(sc.Bytes(), &t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, sc.Err()
}

// validationTasks picks one train task per tier by a seeded hash, so the
// validation loss is measured on tasks the adapter never trained on.
func validationTasks(tasks []task, seed string) map[string]bool {
	best := map[string]string{}
	bestHash := map[string]string{}
	for _, t := range tasks {
		if t.Split != "train" {
			continue
		}
		h := sha256.Sum256([]byte(seed + ":" + t.ID))
		hs := hex.EncodeToString(h[:])
		if bestHash[t.Tier] == "" || hs < bestHash[t.Tier] {
			best[t.Tier], bestHash[t.Tier] = t.ID, hs
		}
	}
	out := map[string]bool{}
	for _, id := range best {
		out[id] = true
	}
	return out
}

func conversation(system, user, assistant string) []message {
	return []message{{"system", system}, {"user", user}, {"assistant", assistant}}
}

// forgeTask emits the direct and repair rows of one train task.
func forgeTask(ctx context.Context, t task, system string, perTask int, verify verifier, st *stats) ([]row, error) {
	entry, sig, err := cortex.SwypSignature(t.Contract)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", t.ID, err)
	}
	ref, err := verify(ctx, t.Reference, t.Contract)
	if err != nil {
		return nil, fmt.Errorf("%s: verifying reference: %w", t.ID, err)
	}
	if ref.Status != "exhaustive" {
		return nil, fmt.Errorf("%s: reference is %s, not exhaustive: %s", t.ID, ref.Status, ref.Summary)
	}
	if got, ok := cortex.ExtractSwypFunction(fence(t.Reference), entry); !ok || got != strings.TrimSpace(t.Reference) {
		return nil, fmt.Errorf("%s: the loop would not extract the reference unchanged", t.ID)
	}
	base := row{Language: "en", Source: "swyp-forge", TaskID: t.ID, Tier: t.Tier}
	direct := base
	direct.Kind, direct.Verdict = "direct", ref.Summary
	direct.Messages = conversation(system, cortex.SwypFirstPrompt(t.Task, sig), fence(t.Reference))
	rows := []row{direct}
	var kept []mutant
	var summaries []string
	for _, m := range mutants(t.Reference) {
		st.MutantsTried++
		v, err := verify(ctx, m.Source, t.Contract)
		if err != nil {
			return nil, fmt.Errorf("%s: verifying %s mutant: %w (infrastructure error, not a verdict)", t.ID, m.Op, err)
		}
		st.MutantStatuses[v.Status]++
		if v.Status == "counterexample" && strings.HasPrefix(v.Summary, "FAIL counterexample: ") {
			kept = append(kept, m)
			summaries = append(summaries, v.Summary)
		}
	}
	byOp := map[string]string{}
	for i, m := range kept {
		byOp[m.Op+"\x00"+m.Source] = summaries[i]
	}
	for _, m := range pickDiverse(kept, perTask) {
		r := base
		r.Kind, r.Op, r.Verdict = "repair", m.Op, byOp[m.Op+"\x00"+m.Source]
		r.Messages = conversation(system, cortex.SwypRepairPrompt(t.Task, sig, m.Source, r.Verdict), fence(t.Reference))
		rows = append(rows, r)
		st.KeptByOp[m.Op]++
	}
	syntaxKept := 0
	syn := syntaxMutants(t.Reference)
	if len(syn) > 0 { // rotate by task so the per-task cap does not always favour the same habits
		h := sha256.Sum256([]byte(t.ID))
		k := int(h[0]) % len(syn)
		syn = append(syn[k:], syn[:k]...)
	}
	for _, m := range syn {
		if syntaxKept >= syntaxPerTask {
			break
		}
		st.SyntaxTried++
		v, err := verify(ctx, m.Source, t.Contract)
		if err != nil {
			return nil, fmt.Errorf("%s: verifying %s mutant: %w (infrastructure error, not a verdict)", t.ID, m.Op, err)
		}
		st.SyntaxStatuses[v.Status]++
		if v.Status != "error" || !strings.HasPrefix(v.Summary, "ERROR ") {
			continue
		}
		r := base
		r.Kind, r.Op, r.Verdict = "repair_syntax", m.Op, v.Summary
		r.Messages = conversation(system, cortex.SwypRepairPrompt(t.Task, sig, m.Source, v.Summary), fence(t.Reference))
		rows = append(rows, r)
		st.KeptByOp[m.Op]++
		syntaxKept++
	}
	return rows, nil
}

// syntaxPerTask caps compile-error repairs per task; set by -syntax-repairs-per-task.
var syntaxPerTask = 3

type modelResult struct {
	ID     string                 `json:"id"`
	Split  string                 `json:"split"`
	Status string                 `json:"status"`
	Report cortex.SwypSolveReport `json:"report"`
}

// modelRows turns verified model replies into rows, re-verifying every
// accepted source. Only train-split results are accepted.
func modelRows(ctx context.Context, path string, byID map[string]task, system string, verify verifier, st *stats) ([]row, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []row
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		var r modelResult
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil || r.ID == "" {
			continue // the trailing summary line
		}
		t, ok := byID[r.ID]
		if !ok || t.Split != "train" || r.Split != "train" {
			return nil, fmt.Errorf("model report %s contains non-train task %q; held-out results never enter training", path, r.ID)
		}
		if r.Status != "verified" {
			continue
		}
		_, sig, err := cortex.SwypSignature(t.Contract)
		if err != nil {
			return nil, err
		}
		v, err := verify(ctx, r.Report.Source, t.Contract)
		if err != nil {
			return nil, err
		}
		if v.Status != "exhaustive" {
			st.ModelRejected++
			continue
		}
		base := row{Language: "en", Source: "swyp-forge-model", TaskID: t.ID, Tier: t.Tier, Verdict: v.Summary}
		atts := r.Report.Attempts
		if len(atts) == 1 {
			d := base
			d.Kind = "model_direct"
			d.Messages = conversation(system, cortex.SwypFirstPrompt(t.Task, sig), fence(r.Report.Source))
			out = append(out, d)
		} else if prev := atts[len(atts)-2]; prev.Verdict != nil && prev.Verdict.Status == "counterexample" && prev.Source != "" {
			d := base
			d.Kind = "model_repair"
			d.Messages = conversation(system, cortex.SwypRepairPrompt(t.Task, sig, prev.Source, prev.Verdict.Summary), fence(r.Report.Source))
			out = append(out, d)
		}
	}
	st.ModelRows += len(out)
	return out, sc.Err()
}

func encodeRows(rows []row) ([]byte, error) {
	var b strings.Builder
	for _, r := range rows {
		data, err := json.Marshal(r)
		if err != nil {
			return nil, err
		}
		b.Write(data)
		b.WriteByte('\n')
	}
	return []byte(b.String()), nil
}

func sha(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func fileSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type output struct {
	Train, Validation []row
	Manifest          map[string]any
}

func build(ctx context.Context, tasks []task, seed string, perTask int, modelReports []string, verify verifier) (output, error) {
	system := cortex.BuildSystemPrompt(nil)
	st := &stats{MutantStatuses: map[string]int{}, KeptByOp: map[string]int{}, SyntaxStatuses: map[string]int{}}
	val := validationTasks(tasks, seed)
	byID := map[string]task{}
	var heldout []string
	for _, t := range tasks {
		byID[t.ID] = t
		if t.Split == "heldout" {
			heldout = append(heldout, t.Task)
		}
	}
	var all []row
	for _, t := range tasks {
		if t.Split != "train" {
			continue
		}
		rows, err := forgeTask(ctx, t, system, perTask, verify, st)
		if err != nil {
			return output{}, err
		}
		all = append(all, rows...)
	}
	for _, path := range modelReports {
		rows, err := modelRows(ctx, path, byID, system, verify, st)
		if err != nil {
			return output{}, err
		}
		all = append(all, rows...)
	}
	var out output
	counts := map[string]int{}
	for _, r := range all {
		for _, m := range r.Messages {
			for _, h := range heldout {
				if strings.Contains(m.Content, h) {
					return output{}, fmt.Errorf("held-out task text leaked into row for %s", r.TaskID)
				}
			}
		}
		if val[r.TaskID] {
			out.Validation = append(out.Validation, r)
		} else {
			out.Train = append(out.Train, r)
		}
		counts[r.Kind]++
	}
	var valIDs []string
	for id := range val {
		valIDs = append(valIDs, id)
	}
	sort.Strings(valIDs)
	out.Manifest = map[string]any{
		"version": 1, "seed": seed, "per_task_repairs": perTask, "per_task_syntax_repairs": syntaxPerTask,
		"system_prompt_sha256": sha([]byte(system)),
		"validation_tasks":     valIDs,
		"rows_by_kind":         counts,
		"stats":                st,
		"notes": "Every assistant answer was verified exhaustive by swyp judge. Every repair prompt quotes the judge's own " +
			"summary for the quoted code: a FAIL counterexample (kind repair) or an ERROR (kind repair_syntax). Held-out tasks " +
			"are excluded. exhaustive = complete execution over a finite domain, not an SMT proof.",
	}
	return out, nil
}

func main() {
	swypExe := flag.String("swyp", "", "Absolute path to the Swyp CLI (required)")
	tasksPath := flag.String("tasks", "swyp/examples/swyp/tasks/tasks.jsonl", "Swyp Forge tasks JSONL")
	outDir := flag.String("out", "", "New output directory (required)")
	seed := flag.String("seed", "swyp-forge-v1", "Seed for the validation-task choice")
	perTask := flag.Int("repairs-per-task", 6, "Maximum counterexample repair rows per task")
	flag.IntVar(&syntaxPerTask, "syntax-repairs-per-task", 3, "Maximum compile-error repair rows per task")
	var reports multiFlag
	flag.Var(&reports, "model-report", "ilaria-swyp -split train report JSONL (repeatable)")
	flag.Parse()
	fail := func(err error) {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
	if *swypExe == "" || *outDir == "" || *perTask < 1 {
		fail(fmt.Errorf("-swyp and -out are required; -repairs-per-task must be positive"))
	}
	if _, err := os.Stat(*outDir); err == nil {
		fail(fmt.Errorf("%s exists; generated data is never overwritten", *outDir))
	}
	judge, err := cortex.NewSwypJudgeChatTool(*swypExe)
	if err != nil {
		fail(err)
	}
	tasks, err := loadTasks(*tasksPath)
	if err != nil {
		fail(err)
	}
	out, err := build(context.Background(), tasks, *seed, *perTask, reports, judge.Verify)
	if err != nil {
		fail(err)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fail(err)
	}
	files := map[string]any{}
	for name, rows := range map[string][]row{"train.jsonl": out.Train, "validation.jsonl": out.Validation} {
		data, err := encodeRows(rows)
		if err != nil {
			fail(err)
		}
		if err := os.WriteFile(filepath.Join(*outDir, name), data, 0o644); err != nil {
			fail(err)
		}
		files[strings.TrimSuffix(name, ".jsonl")] = map[string]any{"rows": len(rows), "sha256": sha(data)}
	}
	inputs := map[string]string{}
	for label, path := range map[string]string{"tasks": *tasksPath, "swyp_exe": *swypExe} {
		if inputs[label], err = fileSHA(path); err != nil {
			fail(err)
		}
	}
	for i, p := range reports {
		if inputs[fmt.Sprintf("model_report_%d", i)], err = fileSHA(p); err != nil {
			fail(err)
		}
	}
	out.Manifest["files"], out.Manifest["inputs_sha256"] = files, inputs
	data, _ := json.MarshalIndent(out.Manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(*outDir, "manifest.json"), append(data, '\n'), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("train %d rows, validation %d rows -> %s\n", len(out.Train), len(out.Validation), *outDir)
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }
