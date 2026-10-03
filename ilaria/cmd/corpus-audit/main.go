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
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
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

	failed := false
	for _, p := range paths {
		rep, err := audit(p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERROR %s: %v\n", p, err)
			failed = true
			continue
		}
		printReport(rep, *sample)

		if *fix && rep.corruption > 0 {
			out := p + ".fixed.jsonl"
			repaired, kept, err := repair(p, out)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  repair FAILED: %v\n", err)
				failed = true
				continue
			}
			fmt.Printf("  → repaired %d lines (skipped %d malformed) → %s\n",
				repaired, kept, out)
		}
	}
	if failed {
		os.Exit(1)
	}
}

func audit(path string) (*report, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	rep := &report{path: path, totalBytes: st.Size(), fields: map[string]int{}}

	err = forEachLine(f, func(raw []byte) error {
		line := string(raw)
		rep.lines++
		if len(raw) > rep.maxLineLen {
			rep.maxLineLen = len(raw)
		}
		if rep.firstLine == "" {
			rep.firstLine = line
		}
		rep.lastLine = line

		var obj map[string]interface{}
		if err := json.Unmarshal(raw, &obj); err != nil {
			rep.parseErrors++
			return nil
		}
		for k, v := range obj {
			if s, ok := v.(string); ok {
				rep.fields[k]++
				rep.totalTextLen += utf8.RuneCountInString(s)
				for _, m := range corruptionMarkers {
					rep.corruption += strings.Count(s, m)
				}
			}
		}
		return nil
	})
	if err != nil {
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
	runes := []rune(s)
	if n <= 0 || len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

func forEachLine(r io.Reader, visit func([]byte) error) error {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSuffix(line, []byte{'\n'})
			line = bytes.TrimSuffix(line, []byte{'\r'})
			if visitErr := visit(line); visitErr != nil {
				return visitErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// repair streams the input, applies double-encoding fixes to known
// text fields, and writes a JSONL output. Returns (linesRepaired,
// linesSkipped, err). Lines that fail to parse are skipped silently.
func repair(in, out string) (repaired, skipped int, err error) {
	src, err := os.Open(in)
	if err != nil {
		return 0, 0, err
	}
	defer src.Close()

	dst, err := os.Create(out)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		if closeErr := dst.Close(); err == nil {
			err = closeErr
		}
	}()

	w := bufio.NewWriterSize(dst, 1<<20)
	err = forEachLine(src, func(line []byte) error {
		var obj map[string]interface{}
		if err := json.Unmarshal(line, &obj); err != nil {
			skipped++
			return nil
		}
		dirty := false
		for k, v := range obj {
			switch k {
			case "text", "instruction", "response", "prompt", "completion", "question", "answer", "content":
			default:
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
		if dirty {
			repaired++
		}
		enc, err := json.Marshal(obj)
		if err != nil {
			return fmt.Errorf("encode repaired JSON: %w", err)
		}
		if _, err := w.Write(enc); err != nil {
			return fmt.Errorf("write repaired JSON: %w", err)
		}
		if err := w.WriteByte('\n'); err != nil {
			return fmt.Errorf("write repaired newline: %w", err)
		}
		return nil
	})
	if err != nil {
		return repaired, skipped, err
	}
	if err = w.Flush(); err != nil {
		return repaired, skipped, fmt.Errorf("flush repaired corpus: %w", err)
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
