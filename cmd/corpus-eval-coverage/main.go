// corpus-eval-coverage — măsoară dacă corpus-ul conține răspunsurile
// necesare pentru ca un model să rezolve task-urile din evalsuite.
//
// Răspunde la întrebarea epistemică: "ar putea modelul EVER să răspundă
// corect la X, având doar acest corpus la dispoziție?"
//
// Pentru fiecare task din evalsuite.Standard, tool-ul:
//
//  1. Asociază task-ului un set de KEYWORDS distinctive din prompt
//     (substantive, entități — adăugate manual în taskKeywords mai jos).
//  2. Extrage răspunsurile așteptate (Expected sau ExpectedNumber).
//  3. Parcurge fiecare linie din corpus și clasifică:
//     - COOCCUR: linia conține CEL PUȚIN UN keyword DIN prompt ȘI
//     CEL PUȚIN UN expected answer (învățare directă)
//     - ANSWER_ONLY: linia conține doar răspunsul, fără context-ul
//     întrebării (vocabular OK, asociere absentă)
//     - NONE: linia n-are nimic relevant
//  4. Etichetează task-ul:
//     - GREEN  ≥ greenThreshold linii cu COOCCUR  (învățabil bine)
//     - YELLOW 1..greenThreshold-1 linii COOCCUR  (învățabil marginal)
//     - RED    0 linii COOCCUR                    (NEÎNVĂȚABIL)
//
// Output: tabel uman + JSON detaliat.
//
// Limitări asumate (vezi §10 HARDCODING.md pentru caveat):
//   - Co-ocurența pe LINIE este aproximare. Modelul vede tokenii într-o
//     fereastră de 512, dar dolly/alpaca au de obicei 1 sample = 1 linie
//     scurtă, deci proximitatea pe linie e bună apropximare.
//   - "expected: paris" + "prompt keyword: france" se potrivește case-
//     insensitive substring match. Asta poate produce false-positive
//     (ex: "Paris Hilton" se potrivește pentru fact_capital_france) —
//     dar pentru verdict GREEN/RED, false-positive sunt acceptabile;
//     ne pasă mai mult de RED (zero match) care e robust.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"ilaria/cortex/evalsuite"
)

// taskKeywords mapează ID-ul fiecărui task la cuvintele-cheie care
// trebuie să apară în linie pentru ca aceasta să conteze ca CONTEXT
// (prompt-side). Este tabela editorială centrală a acestui tool — dacă
// adăugăm task noi în evalsuite.Standard, adăugăm și keywords aici.
//
// Reguli editoriale:
//   - Lowercase only (matching e case-insensitive oricum).
//   - Includem doar substantive/entități distinctive — NU verbe sau
//     cuvinte funcționale ("what", "is", "are").
//   - Sinonime acceptabile dacă întrebarea ar putea fi pusă diferit
//     în corpus (ex: "h2o" → "water" e expected, nu keyword).
//   - Pentru task numeric, keywords includ contextul (ex:
//     "math_word_apples" → ["alice", "apples", "bob"]) pentru a găsi
//     contexte din care s-ar putea învăța aritmetica narativă.
var taskKeywords = map[string][]string{
	// ── factual ─────────────────────────────────────────────────
	"fact_capital_france":  {"capital", "france"},
	"fact_capital_japan":   {"capital", "japan"},
	"fact_capital_germany": {"capital", "germany"},
	"fact_romeo_juliet":    {"romeo", "juliet"},
	"fact_relativity":      {"relativity", "theory"},
	"fact_largest_planet":  {"largest", "planet"},
	"fact_h2o":             {"chemical", "water", "formula"},
	"fact_continents":      {"continents"},

	// ── math (numeric — keywords contextul aritmetic) ───────────
	"math_add_basic":   {"15", "27", "plus", "add"},
	"math_mul":         {"12", "7", "times", "multiply"},
	"math_sub":         {"100", "37", "minus", "subtract"},
	"math_div":         {"144", "12", "divided", "divide"},
	"math_sqrt":        {"square", "root", "81"},
	"math_word_apples": {"alice", "apples", "bob"},

	// ── instruct ────────────────────────────────────────────────
	"instr_primary_colors":         {"primary", "colors"},
	"instr_translate_hello_es":     {"hello", "spanish"},
	"instr_translate_good_morning": {"good morning", "spanish"},
	"instr_define_photo":           {"photosynthesis"},
	"instr_yesno":                  {"earth", "round"},

	// ── reasoning ───────────────────────────────────────────────
	"reason_seq_arith": {"2, 4, 6, 8", "sequence"},
	"reason_seq_geom":  {"1, 2, 4, 8, 16", "sequence"},
	"reason_syllogism": {"penguin", "bird", "fly"},
	"reason_age":       {"anna", "mark", "years old"},
	"reason_compare":   {"larger", "0.9", "0.11"},
}

// taskExpectedStrings returnează stringurile pe care căutăm să le găsim
// ca "răspuns" — fie din Expected[], fie din ExpectedNumber convertit
// în reprezentări multiple (ex: 42 → "42", "forty-two").
func taskExpectedStrings(t evalsuite.Task) []string {
	out := []string{}
	for _, e := range t.Expected {
		out = append(out, strings.ToLower(strings.TrimSpace(e)))
	}
	if t.Mode == evalsuite.ModeNumeric {
		// Numeric: căutăm reprezentarea numerică + variante text-uale
		// uzuale. Pentru numerele mici (sub 20) adăugăm forma scrisă
		// în engleză, pentru că dolly/alpaca conține multă engleză
		// narativă unde numerele apar adesea spelled-out.
		n := t.ExpectedNumber
		nInt := int(n)
		if float64(nInt) == n {
			out = append(out, strconv.Itoa(nInt))
			if nInt >= 0 && nInt < len(englishNumbers) {
				out = append(out, englishNumbers[nInt])
			}
		} else {
			out = append(out, strconv.FormatFloat(n, 'g', -1, 64))
		}
	}
	return out
}

// englishNumbers — forme scrise pentru 0..20, suficient pentru toate
// task-urile numerice din evalsuite (max expected = 84).
// Notă: pentru 84 nu e fezabilă forma scrisă unică, dar majoritatea
// task-urilor numerice au răspuns ≤ 15, deci e suficient.
var englishNumbers = []string{
	"zero", "one", "two", "three", "four", "five", "six", "seven",
	"eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
	"fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
}

// prepared wraps a Task with the precomputed lowercase keyword and
// expected-answer slices, plus a pointer to the running tally that
// scanCorpus will update. Declarat la package-level ca să fie folosit
// atât în main cât și în signature-ul scanCorpus.
type prepared struct {
	task     evalsuite.Task
	keywords []string
	expected []string
	stats    *taskStats
}

type taskStats struct {
	TaskID        string   `json:"task_id"`
	Category      string   `json:"category"`
	Prompt        string   `json:"prompt"`
	Keywords      []string `json:"keywords"`
	Expected      []string `json:"expected"`
	LinesCooccur  int      `json:"lines_cooccur"`     // PROMPT-CTX + ANSWER
	LinesAnsOnly  int      `json:"lines_answer_only"` // ANSWER fără prompt-ctx
	LinesPrOnly   int      `json:"lines_prompt_only"` // PROMPT-CTX fără answer
	Verdict       string   `json:"verdict"`
	SampleCooccur []string `json:"sample_cooccur,omitempty"` // primele 3 linii
}

type corpusReport struct {
	CorpusPaths    []string    `json:"corpus_paths"`
	TotalLines     int         `json:"total_lines"`
	Tasks          []taskStats `json:"tasks"`
	GreenCount     int         `json:"green_count"`
	YellowCount    int         `json:"yellow_count"`
	RedCount       int         `json:"red_count"`
	GreenThreshold int         `json:"green_threshold"`
}

func main() {
	corpusFlag := flag.String("corpus", "./data/corpus/dolly.jsonl,./data/corpus/alpaca.jsonl",
		"Comma-separated corpus JSONL paths")
	greenThreshold := flag.Int("green-threshold", 10,
		"Min lines with COOCCUR for task to be GREEN; 1..threshold-1 = YELLOW; 0 = RED")
	outPath := flag.String("out", "",
		"Optional JSON output path (omit = no JSON written)")
	sampleN := flag.Int("samples", 3,
		"Number of sample COOCCUR lines to capture per task (0 = none)")
	flag.Parse()

	corpora := []string{}
	for _, p := range strings.Split(*corpusFlag, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			corpora = append(corpora, p)
		}
	}
	if len(corpora) == 0 {
		fmt.Fprintln(os.Stderr, "no corpus paths provided")
		os.Exit(2)
	}

	// Pre-build per-task lowercase keyword/expected slices.
	prepTasks := make([]prepared, 0, len(evalsuite.Standard))
	for _, t := range evalsuite.Standard {
		kws := taskKeywords[t.ID]
		if len(kws) == 0 {
			fmt.Fprintf(os.Stderr, "WARNING: no keywords defined for task %s — skipping\n", t.ID)
			continue
		}
		exp := taskExpectedStrings(t)
		st := &taskStats{
			TaskID:   t.ID,
			Category: t.Category,
			Prompt:   t.Prompt,
			Keywords: kws,
			Expected: exp,
		}
		prepTasks = append(prepTasks, prepared{task: t, keywords: kws, expected: exp, stats: st})
	}

	totalLines := 0
	for _, path := range corpora {
		n, err := scanCorpus(path, prepTasks, *sampleN)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR scanning %s: %v\n", path, err)
			os.Exit(3)
		}
		totalLines += n
		fmt.Printf("scanned %s: %d lines\n", filepath.Base(path), n)
	}

	// Aggregate verdicts.
	report := corpusReport{
		CorpusPaths:    corpora,
		TotalLines:     totalLines,
		GreenThreshold: *greenThreshold,
	}
	for _, pt := range prepTasks {
		st := pt.stats
		switch {
		case st.LinesCooccur >= *greenThreshold:
			st.Verdict = "GREEN"
			report.GreenCount++
		case st.LinesCooccur > 0:
			st.Verdict = "YELLOW"
			report.YellowCount++
		default:
			st.Verdict = "RED"
			report.RedCount++
		}
		report.Tasks = append(report.Tasks, *st)
	}

	printReport(&report)

	if *outPath != "" {
		b, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "marshal report: %v\n", err)
			os.Exit(4)
		}
		if err := os.WriteFile(*outPath, b, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write report: %v\n", err)
			os.Exit(4)
		}
		fmt.Printf("\nJSON report: %s\n", *outPath)
	}
}

// scanCorpus parcurge un fișier JSONL și pentru fiecare linie verifică
// fiecare task. Update direct în taskStats prin pointer.
//
// Returnează numărul de linii scanate.
func scanCorpus(path string, prepTasks []prepared, sampleN int) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 4<<20)

	lineCount := 0
	for scanner.Scan() {
		lineCount++
		raw := scanner.Bytes()
		text := extractText(raw)
		if text == "" {
			continue
		}
		lower := strings.ToLower(text)

		for _, pt := range prepTasks {
			hasKw := containsAny(lower, pt.keywords)
			hasAns := containsAny(lower, pt.expected)
			switch {
			case hasKw && hasAns:
				pt.stats.LinesCooccur++
				if sampleN > 0 && len(pt.stats.SampleCooccur) < sampleN {
					pt.stats.SampleCooccur = append(pt.stats.SampleCooccur, truncate(text, 200))
				}
			case hasAns:
				pt.stats.LinesAnsOnly++
			case hasKw:
				pt.stats.LinesPrOnly++
			}
		}
	}
	return lineCount, scanner.Err()
}

// containsAny verifică dacă haystack conține CEL PUȚIN UN substring.
// Toate sunt deja lowercase.
func containsAny(haystack string, needles []string) bool {
	for _, n := range needles {
		if n != "" && strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}

// extractText oglindește logica din extractCorpusText din trainer:
// suportă text/instruction+response/prompt+completion/question+answer.
func extractText(raw []byte) string {
	if len(raw) == 0 || raw[0] != '{' {
		return ""
	}
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		return ""
	}
	if t, ok := data["text"].(string); ok && t != "" {
		return t
	}
	instr, _ := data["instruction"].(string)
	resp, _ := data["response"].(string)
	if instr != "" && resp != "" {
		return instr + " " + resp
	}
	prm, _ := data["prompt"].(string)
	cpl, _ := data["completion"].(string)
	if prm != "" && cpl != "" {
		return prm + " " + cpl
	}
	q, _ := data["question"].(string)
	a, _ := data["answer"].(string)
	if q != "" && a != "" {
		return q + " " + a
	}
	if c, ok := data["content"].(string); ok && c != "" {
		return c
	}
	return ""
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func printReport(r *corpusReport) {
	// Sortăm task-urile: RED primul (cea mai importantă info), apoi
	// YELLOW, apoi GREEN. În cadrul fiecărui verdict, sortăm după
	// LinesCooccur ascendent.
	sorted := make([]taskStats, len(r.Tasks))
	copy(sorted, r.Tasks)
	sort.SliceStable(sorted, func(i, j int) bool {
		order := map[string]int{"RED": 0, "YELLOW": 1, "GREEN": 2}
		if order[sorted[i].Verdict] != order[sorted[j].Verdict] {
			return order[sorted[i].Verdict] < order[sorted[j].Verdict]
		}
		return sorted[i].LinesCooccur < sorted[j].LinesCooccur
	})

	fmt.Printf("\n=== CORPUS EVAL COVERAGE REPORT ===\n")
	fmt.Printf("Corpus: %s\n", strings.Join(r.CorpusPaths, ", "))
	fmt.Printf("Total lines scanned: %d\n", r.TotalLines)
	fmt.Printf("GREEN threshold: ≥%d lines with co-occurrence\n\n", r.GreenThreshold)

	fmt.Printf("%-32s %-10s %-8s %8s %8s %8s\n",
		"TASK_ID", "CATEGORY", "VERDICT", "COOCCUR", "ANS_ONLY", "PR_ONLY")
	fmt.Println(strings.Repeat("-", 86))
	for _, t := range sorted {
		fmt.Printf("%-32s %-10s %-8s %8d %8d %8d\n",
			t.TaskID, t.Category, t.Verdict,
			t.LinesCooccur, t.LinesAnsOnly, t.LinesPrOnly)
	}

	fmt.Printf("\n=== SUMMARY ===\n")
	total := r.GreenCount + r.YellowCount + r.RedCount
	fmt.Printf("GREEN  (learnable):              %2d / %d  (%.0f%%)\n",
		r.GreenCount, total, pct(r.GreenCount, total))
	fmt.Printf("YELLOW (marginal):               %2d / %d  (%.0f%%)\n",
		r.YellowCount, total, pct(r.YellowCount, total))
	fmt.Printf("RED    (UNLEARNABLE this corpus): %2d / %d  (%.0f%%)\n",
		r.RedCount, total, pct(r.RedCount, total))

	// Verdict global: dacă RED ≥ 50%, eval suite e incompatibil cu corpus.
	fmt.Printf("\n=== VERDICT ===\n")
	switch {
	case r.RedCount >= total/2:
		fmt.Printf("⚠ Over half of eval tasks are UNLEARNABLE from this corpus.\n")
		fmt.Printf("  Even infinite training cannot push accuracy past %d/%d (%.0f%%).\n",
			r.GreenCount+r.YellowCount, total,
			pct(r.GreenCount+r.YellowCount, total))
		fmt.Printf("  → Add a knowledge corpus (Wikipedia, factbooks) OR trim eval suite.\n")
	case r.RedCount > 0:
		fmt.Printf("✓ Most eval tasks are learnable; %d are not.\n", r.RedCount)
		fmt.Printf("  Hard ceiling on accuracy from this corpus: ~%.0f%%.\n",
			pct(r.GreenCount+r.YellowCount, total))
	default:
		fmt.Printf("✓ All eval tasks have at least some support in this corpus.\n")
	}
}

func pct(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return 100 * float64(n) / float64(total)
}
