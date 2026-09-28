package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ilaria/cortex"
)

// ─────────────────────────────────────────────────────────────────────
// cortex-tokenizer — CLI tool for training and testing BPE tokenizers
// ─────────────────────────────────────────────────────────────────────
//
// Usage:
//   Train from a text file:
//     go run cmd/cortex-tokenizer/main.go -train -input corpus.txt -vocab-size 8192 -output tokenizer.json
//
//   Train from JSONL files:
//     go run cmd/cortex-tokenizer/main.go -train -input data/corpus/dolly.jsonl -vocab-size 8192
//
//   Train from all corpus files in a directory:
//     go run cmd/cortex-tokenizer/main.go -train -corpus-dir data/corpus -vocab-size 8192
//
//   Train from multiple files (comma-separated):
//     go run cmd/cortex-tokenizer/main.go -train -input "a.jsonl,b.jsonl,c.txt" -vocab-size 8192
//
//   Encode text with an existing tokenizer:
//     go run cmd/cortex-tokenizer/main.go -encode "Hello world" -tokenizer tokenizer.json
//
//   Interactive mode:
//     go run cmd/cortex-tokenizer/main.go -interactive -tokenizer tokenizer.json

func main() {
	// Flags
	trainMode := flag.Bool("train", false, "Train a new tokenizer from corpus")
	inputFile := flag.String("input", "", "Input corpus file(s), comma-separated (.txt or .jsonl)")
	corpusDir := flag.String("corpus-dir", "", "Directory of corpus files (.txt and .jsonl) to train on")
	outputFile := flag.String("output", "data/tokenizer.json", "Output tokenizer file path")
	vocabSize := flag.Int("vocab-size", 8192, "Target vocabulary size")
	maxLines := flag.Int("max-lines", 0, "Max lines to use from corpus (0 = all)")
	tokenizerFile := flag.String("tokenizer", "", "Path to trained tokenizer for encode/decode")
	encodeText := flag.String("encode", "", "Text to encode")
	interactive := flag.Bool("interactive", false, "Interactive encode/decode mode")

	flag.Parse()

	if *trainMode {
		runTrain(*inputFile, *corpusDir, *outputFile, *vocabSize, *maxLines)
		return
	}

	if *encodeText != "" {
		if *tokenizerFile == "" {
			fmt.Fprintln(os.Stderr, "Error: -tokenizer required for encoding")
			os.Exit(1)
		}
		runEncode(*tokenizerFile, *encodeText)
		return
	}

	if *interactive {
		if *tokenizerFile == "" {
			fmt.Fprintln(os.Stderr, "Error: -tokenizer required for interactive mode")
			os.Exit(1)
		}
		runInteractive(*tokenizerFile)
		return
	}

	flag.Usage()
}

// jsonlRecord represents a single line in a JSONL corpus file.
// Supports multiple formats: {text}, {instruction, response}, {instruction, context, response}.
type jsonlRecord struct {
	Text        string `json:"text"`
	Instruction string `json:"instruction"`
	Response    string `json:"response"`
	Context     string `json:"context"`
	Input       string `json:"input"`
	Output      string `json:"output"`
	Question    string `json:"question"`
	Answer      string `json:"answer"`
}

// extractText pulls all usable text from a JSONL record.
func (r *jsonlRecord) extractText() []string {
	var parts []string

	// Direct text field
	if r.Text != "" {
		parts = append(parts, r.Text)
	}

	// instruction + response format (Dolly, Alpaca, general)
	if r.Instruction != "" {
		// Include context if present
		if r.Context != "" {
			parts = append(parts, r.Context)
		}
		parts = append(parts, r.Instruction)
	}
	if r.Response != "" {
		parts = append(parts, r.Response)
	}

	// input/output format
	if r.Input != "" {
		parts = append(parts, r.Input)
	}
	if r.Output != "" {
		parts = append(parts, r.Output)
	}

	// question/answer format (GSM8K)
	if r.Question != "" {
		parts = append(parts, r.Question)
	}
	if r.Answer != "" {
		parts = append(parts, r.Answer)
	}

	return parts
}

func runTrain(inputFile, corpusDir, outputFile string, vocabSize, maxLines int) {
	if inputFile == "" && corpusDir == "" {
		fmt.Fprintln(os.Stderr, "Error: -input or -corpus-dir required for training")
		os.Exit(1)
	}

	fmt.Printf("╔══════════════════════════════════════════════════════╗\n")
	fmt.Printf("║      Ilaria — BPE Tokenizer Trainer          ║\n")
	fmt.Printf("╚══════════════════════════════════════════════════════╝\n\n")

	// Gather input files
	var files []string
	if corpusDir != "" {
		fmt.Printf("[0/4] Scanning corpus directory: %s\n", corpusDir)
		entries, err := os.ReadDir(corpusDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading corpus dir: %v\n", err)
			os.Exit(1)
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasSuffix(name, ".txt") || strings.HasSuffix(name, ".jsonl") {
				files = append(files, filepath.Join(corpusDir, name))
			}
		}
		fmt.Printf("      → Found %d corpus files\n\n", len(files))
	}
	if inputFile != "" {
		for _, f := range strings.Split(inputFile, ",") {
			f = strings.TrimSpace(f)
			if f != "" {
				files = append(files, f)
			}
		}
	}

	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "Error: no corpus files found")
		os.Exit(1)
	}

	// Read all corpus files
	fmt.Printf("[1/4] Reading corpus from %d file(s)...\n", len(files))
	var allLines []string
	for _, f := range files {
		lines, err := readCorpusFile(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: failed to read %s: %v\n", f, err)
			continue
		}
		fmt.Printf("      → %s: %d lines\n", filepath.Base(f), len(lines))
		allLines = append(allLines, lines...)
	}

	if maxLines > 0 && len(allLines) > maxLines {
		fmt.Printf("      → Limiting to %d lines (from %d total)\n", maxLines, len(allLines))
		allLines = allLines[:maxLines]
	}

	fmt.Printf("      → Total: %d lines loaded\n\n", len(allLines))

	if len(allLines) == 0 {
		fmt.Fprintln(os.Stderr, "Error: no text lines extracted from corpus")
		os.Exit(1)
	}

	// Train
	fmt.Printf("[2/4] Training BPE tokenizer (target vocab: %d)...\n", vocabSize)
	start := time.Now()

	tok := cortex.NewBPETokenizer(vocabSize)
	tok.Train(allLines)

	elapsed := time.Since(start)
	fmt.Printf("      → Training completed in %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("      → Final vocab: %d tokens, %d merges\n\n", tok.ActualVocabSize(), len(tok.Merges))

	// Ensure output directory exists
	outDir := filepath.Dir(outputFile)
	if outDir != "" && outDir != "." {
		os.MkdirAll(outDir, 0755)
	}

	// Save
	fmt.Printf("[3/4] Saving tokenizer to %s...\n", outputFile)
	if err := tok.Save(outputFile); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving: %v\n", err)
		os.Exit(1)
	}

	info, _ := os.Stat(outputFile)
	fmt.Printf("      → Saved (%d bytes)\n\n", info.Size())

	// Verify: reload and test
	fmt.Println("[4/4] Verification — reload & roundtrip test")
	tok2, err := cortex.LoadBPETokenizer(outputFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ✗ Failed to reload tokenizer: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("      → Reloaded OK (vocab: %d, merges: %d)\n\n", tok2.ActualVocabSize(), len(tok2.Merges))

	fmt.Println("── Roundtrip Tests ────────────────────────────────────")
	testTexts := []string{
		"Hello world",
		"the cat sat on the mat",
		"Ilaria is a neural architecture project.",
		"neurons fire together and wire together",
	}

	// Also use first few corpus lines as test samples
	for i, line := range allLines {
		if i >= 3 {
			break
		}
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > 100 {
			trimmed = trimmed[:100]
		}
		if trimmed != "" {
			testTexts = append(testTexts, trimmed)
		}
	}

	allPassed := true
	for _, text := range testTexts {
		ids := tok2.Encode(text)
		tokens := tok2.DecodeTokens(ids)
		decoded := tok2.Decode(ids)
		fmt.Printf("  Input:   %q\n", text)
		fmt.Printf("  Tokens:  %v\n", tokens)
		fmt.Printf("  IDs:     %v (count: %d)\n", ids, len(ids))
		fmt.Printf("  Decoded: %q\n", decoded)
		if decoded == text {
			fmt.Println("  ✓ Roundtrip OK")
		} else {
			fmt.Println("  ✗ Roundtrip FAILED")
			allPassed = false
		}
		fmt.Println()
	}

	if allPassed {
		fmt.Println("═══════════════════════════════════════════════════════")
		fmt.Println("  ✓ All roundtrip tests PASSED")
		fmt.Println("═══════════════════════════════════════════════════════")
	} else {
		fmt.Println("═══════════════════════════════════════════════════════")
		fmt.Println("  ⚠ Some roundtrip tests FAILED")
		fmt.Println("═══════════════════════════════════════════════════════")
	}
}

func runEncode(tokenizerFile, text string) {
	tok, err := cortex.LoadBPETokenizer(tokenizerFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading tokenizer: %v\n", err)
		os.Exit(1)
	}

	ids := tok.Encode(text)
	tokens := tok.DecodeTokens(ids)
	decoded := tok.Decode(ids)

	fmt.Printf("Input:     %q\n", text)
	fmt.Printf("Token IDs: %v\n", ids)
	fmt.Printf("Tokens:    %v\n", tokens)
	fmt.Printf("Decoded:   %q\n", decoded)
	fmt.Printf("Count:     %d tokens\n", len(ids))
}

func runInteractive(tokenizerFile string) {
	tok, err := cortex.LoadBPETokenizer(tokenizerFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading tokenizer: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Ilaria BPE Tokenizer — Interactive Mode\n")
	fmt.Printf("Vocab: %d tokens, %d merges\n", tok.ActualVocabSize(), len(tok.Merges))
	fmt.Printf("Type text to tokenize (Ctrl+C to exit):\n\n")

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}
		text := scanner.Text()
		if text == "" {
			continue
		}

		ids := tok.Encode(text)
		tokens := tok.DecodeTokens(ids)
		decoded := tok.Decode(ids)

		fmt.Printf("  Tokens:  %v\n", tokens)
		fmt.Printf("  IDs:     %v\n", ids)
		fmt.Printf("  Count:   %d\n", len(ids))
		fmt.Printf("  Decoded: %q\n", decoded)
		if decoded == text {
			fmt.Println("  ✓ Roundtrip OK")
		} else {
			fmt.Println("  ✗ Roundtrip MISMATCH")
		}
		fmt.Println()
	}
}

// readCorpusFile reads a corpus file, supporting both .txt and .jsonl formats.
func readCorpusFile(path string) ([]string, error) {
	if strings.HasSuffix(path, ".jsonl") {
		return readJSONL(path)
	}
	return readLines(path)
}

// readJSONL reads a JSONL corpus file and extracts text from all fields.
func readJSONL(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 2*1024*1024), 2*1024*1024)

	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}

		var rec jsonlRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue // skip malformed lines
		}

		texts := rec.extractText()
		for _, t := range texts {
			t = strings.TrimSpace(t)
			if t != "" {
				lines = append(lines, t)
			}
		}
	}

	return lines, scanner.Err()
}

// readLines reads a plain text file (one sentence/document per line).
func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines, scanner.Err()
}
