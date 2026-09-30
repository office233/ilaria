// corpus-audit — inspect and (optionally) repair training corpora.
//
// Walks one or more JSONL files and reports:
//   - line count, total bytes, average line length
//   - decoded text length (chars vs bytes)
//   - heuristic encoding-corruption score (counts the most common
//     double-encoded Romanian markers like "Č›", "Ăź", "Ă®")
//   - sample first/last line
//
// When --fix is set, also emits a repaired copy at <input>.fixed.jsonl
// where the double-encoding markers are replaced with their intended
// Romanian characters. Repair is conservative: it only touches the
// "text", "instruction", "response", "prompt", "completion", "question",
// "answer", "content" fields and leaves any other JSON structure alone.
//
// Usage:
//
//	corpus-audit data/corpus/*.jsonl
//	corpus-audit --fix data/corpus/wikipedia_ro.jsonl
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// doubleEncodingMap maps known mojibake sequences (cp1252 read as UTF-8)
// back to their intended Romanian / accented characters. Order matters:
// longer sequences first so they don't get partially eaten by shorter
// rules. The list is curated for Romanian + common English diacritics
// the user may also have in mixed corpora.
var doubleEncodingMap = []struct {
	bad, good string
}{
	// Romanian-specific (cp1250 / cp1252 mis-decoded as UTF-8)
	{"Č™", "ș"},
	{"Č›", "ț"},
	{"Č˜", "Ș"},
	{"Čš", "Ț"},
	{"Ă˘", "â"},
	{"Ă‚", "Â"},
	{"Ă®", "î"},
	{"ĂŽ", "Î"},
	{"Ă©", "é"},
	{"Ă¨", "è"},
	{"Ăˇ", "á"},
	{"Ăź", "ß"},
	{"Ă¶", "ö"},
	{"Ăľ", "ü"},
	{"Ă¤", "ä"},
	// Generic broken UTF-8 markers
	{"â€™", "'"},
	{"â€œ", "\""},
	{"â€\u009d", "\""},
	{"â€“", "–"},
	{"â€”", "—"},
	{"â€¦", "…"},
	// Stray replacement char from earlier passes
	{"\ufeff", ""},
}

// corruptionMarkers are the substrings whose presence indicates the
// file probably went through a double-encoding accident. Used for the
// audit score; NOT used for the repair itself (that uses doubleEncodingMap).
var corruptionMarkers = []string{
	"Č›", "Č™", "Ă®", "Ăź", "Ă˘", "â€™", "â€œ",
}

type fieldStats struct {
	field string
	count int
}

type report struct {
	path         string
	lines        int
	totalBytes   int64
	totalTextLen int
	maxLineLen   int
	corruption   int     // count of marker hits across all lines
	corruptionPM float64 // markers per million bytes
	parseErrors  int
	fields       map[string]int
	firstLine    string
	lastLine     string
}

func main() {
	fix := flag.Bool("fix", false, "Write repaired <input>.fixed.jsonl copies for any inputs with corruption")
	sample := flag.Int("sample", 80, "Truncate sample lines to this many chars in the report")
	flag.Parse()

	paths := flag.Args()
	if len(paths) == 0 {
		fmt.Fprintln(os.Stderr, "usage: corpus-audit [--fix] <file.jsonl> [...]")
		os.Exit(2)
	}

	for _, p := range paths {
		rep, err := audit(p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR %s: %v\n", p, err)
			continue
		}
		printReport(rep, *sample)

		if *fix && rep.corruption > 0 {
			out := p + ".fixed.jsonl"
			repaired, kept, err := repair(p, out)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  repair FAILED: %v\n", err)
				continue
			}
			fmt.Printf("  → repaired %d lines (skipped %d malformed) → %s\n",
				repaired, kept, out)
		}
	}
}

func audit(path string) (*report, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	st, _ := f.Stat()
	rep := &report{path: path, totalBytes: st.Size(), fields: map[string]int{}}

	scanner := bufio.NewScanner(f)
	// Some Wikipedia articles exceed 1 MB on a single line — give the
	// scanner a generous buffer to avoid spurious "token too long" errors.
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		rep.lines++
		if len(line) > rep.maxLineLen {
			rep.maxLineLen = len(line)
		}
		if rep.firstLine == "" {
			rep.firstLine = line
		}
		rep.lastLine = line

		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			rep.parseErrors++
			continue
		}
		for k, v := range obj {
			if s, ok := v.(string); ok {
				rep.fields[k]++
				rep.totalTextLen += len(s)
				for _, m := range corruptionMarkers {
					rep.corruption += strings.Count(s, m)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return rep, err
	}
	if rep.totalBytes > 0 {
		rep.corruptionPM = float64(rep.corruption) / float64(rep.totalBytes) * 1e6
	}
	return rep, nil
}

func printReport(r *report, sampleLen int) {
	name := filepath.Base(r.path)
	fmt.Printf("=== %s ===\n", name)
	fmt.Printf("  lines:        %d\n", r.lines)
	fmt.Printf("  bytes:        %d (%.2f MB)\n", r.totalBytes, float64(r.totalBytes)/1024/1024)
	fmt.Printf("  text chars:   %d (%.2f MB)\n", r.totalTextLen, float64(r.totalTextLen)/1024/1024)
	if r.lines > 0 {
		fmt.Printf("  avg line:     %d bytes\n", r.totalBytes/int64(r.lines))
	}
	fmt.Printf("  max line:     %d bytes\n", r.maxLineLen)
	fmt.Printf("  parse errors: %d\n", r.parseErrors)

	fmt.Printf("  fields:")
	keys := make([]fieldStats, 0, len(r.fields))
	for k, v := range r.fields {
		keys = append(keys, fieldStats{k, v})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].count > keys[j].count })
	for _, k := range keys {
		fmt.Printf("  %s=%d", k.field, k.count)
	}
	fmt.Println()

	if r.corruption > 0 {
		fmt.Printf("  ⚠ corruption: %d markers (%.1f per MB) — run with --fix\n",
			r.corruption, r.corruptionPM)
	} else {
		fmt.Printf("  ✓ encoding:   clean\n")
	}

	if r.firstLine != "" {
		fmt.Printf("  first: %s\n", truncate(r.firstLine, sampleLen))
	}
	if r.lastLine != "" && r.lastLine != r.firstLine {
		fmt.Printf("  last:  %s\n", truncate(r.lastLine, sampleLen))
	}
	fmt.Println()
}

func truncate(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// repair streams the input, applies double-encoding fixes to known
// text fields, and writes a JSONL output. Returns (linesRepaired,
// linesSkipped, err). Lines that fail to parse are skipped silently.
func repair(in, out string) (int, int, error) {
	src, err := os.Open(in)
	if err != nil {
		return 0, 0, err
	}
	defer src.Close()

	dst, err := os.Create(out)
	if err != nil {
		return 0, 0, err
	}
	defer dst.Close()

	w := bufio.NewWriterSize(dst, 1<<20)
	defer w.Flush()

	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)

	textFields := map[string]bool{
		"text": true, "instruction": true, "response": true,
		"prompt": true, "completion": true, "question": true,
		"answer": true, "content": true,
	}

	repaired := 0
	skipped := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		var obj map[string]interface{}
		if err := json.Unmarshal(line, &obj); err != nil {
			skipped++
			continue
		}
		dirty := false
		for k, v := range obj {
			if !textFields[k] {
				continue
			}
			if s, ok := v.(string); ok {
				fixed := fixEncoding(s)
				if fixed != s {
					obj[k] = fixed
					dirty = true
				}
			}
		}
		_ = dirty // emit every parsed line so the output is a complete corpus
		enc, err := json.Marshal(obj)
		if err != nil {
			skipped++
			continue
		}
		w.Write(enc)
		w.WriteByte('\n')
		repaired++
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return repaired, skipped, err
	}
	return repaired, skipped, nil
}

func fixEncoding(s string) string {
	for _, pair := range doubleEncodingMap {
		if strings.Contains(s, pair.bad) {
			s = strings.ReplaceAll(s, pair.bad, pair.good)
		}
	}
	return s
}
