package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Supported input formats
type RawItem struct {
	// Our format
	Instruction string `json:"instruction,omitempty"`
	Response    string `json:"response,omitempty"`
	// Alt format
	Prompt     string `json:"prompt,omitempty"`
	Completion string `json:"completion,omitempty"`
	// GSM8K format
	Question string `json:"question,omitempty"`
	Answer   string `json:"answer,omitempty"`
	// Text-only
	Text    string `json:"text,omitempty"`
	Content string `json:"content,omitempty"`
}

// Our canonical format
type CanonicalItem struct {
	Instruction string `json:"instruction,omitempty"`
	Response    string `json:"response,omitempty"`
	Text        string `json:"text,omitempty"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: corpus-convert <input.jsonl> <output.jsonl>")
		os.Exit(2)
	}

	converted, skipped, err := convert(os.Args[1], os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "corpus-convert: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Converted %d items (%d skipped) -> %s\n", converted, skipped, os.Args[2])
}

func convert(inputPath, outputPath string) (converted, skipped int, err error) {
	inFile, err := os.Open(inputPath)
	if err != nil {
		return 0, 0, fmt.Errorf("open input: %w", err)
	}
	defer inFile.Close()
	inputInfo, err := inFile.Stat()
	if err != nil {
		return 0, 0, fmt.Errorf("stat input: %w", err)
	}
	if outputInfo, statErr := os.Stat(outputPath); statErr == nil {
		if os.SameFile(inputInfo, outputInfo) {
			return 0, 0, errors.New("input and output refer to the same file")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return 0, 0, fmt.Errorf("stat output: %w", statErr)
	}

	outFile, err := os.Create(outputPath)
	if err != nil {
		return 0, 0, fmt.Errorf("create output: %w", err)
	}
	defer func() {
		if closeErr := outFile.Close(); err == nil {
			err = closeErr
		}
	}()

	writer := bufio.NewWriter(outFile)
	reader := bufio.NewReader(inFile)

	for {
		line, readErr := reader.ReadBytes('\n')
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			var raw RawItem
			if err := json.Unmarshal(line, &raw); err != nil {
				skipped++
			} else if out, ok := canonicalize(raw); !ok {
				skipped++
			} else {
				data, err := json.Marshal(out)
				if err != nil {
					return converted, skipped, fmt.Errorf("encode output: %w", err)
				}
				if _, err := writer.Write(data); err != nil {
					return converted, skipped, fmt.Errorf("write output: %w", err)
				}
				if err := writer.WriteByte('\n'); err != nil {
					return converted, skipped, fmt.Errorf("write newline: %w", err)
				}
				converted++
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return converted, skipped, fmt.Errorf("read input: %w", readErr)
		}
	}

	if err := writer.Flush(); err != nil {
		return converted, skipped, fmt.Errorf("flush output: %w", err)
	}
	return converted, skipped, nil
}

func canonicalize(raw RawItem) (CanonicalItem, bool) {
	switch {
	case raw.Instruction != "" && raw.Response != "":
		return CanonicalItem{Instruction: raw.Instruction, Response: raw.Response}, true
	case raw.Question != "" && raw.Answer != "":
		return CanonicalItem{Instruction: raw.Question, Response: stripCalculations(raw.Answer)}, true
	case raw.Prompt != "" && raw.Completion != "":
		return CanonicalItem{Instruction: raw.Prompt, Response: raw.Completion}, true
	case raw.Text != "":
		return CanonicalItem{Text: raw.Text}, true
	case raw.Content != "":
		return CanonicalItem{Text: raw.Content}, true
	default:
		return CanonicalItem{}, false
	}
}

func stripCalculations(answer string) string {
	for {
		start := strings.Index(answer, "<<")
		if start < 0 {
			return strings.TrimSpace(answer)
		}
		relativeEnd := strings.Index(answer[start+2:], ">>")
		if relativeEnd < 0 {
			return strings.TrimSpace(answer)
		}
		end := start + 2 + relativeEnd
		answer = answer[:start] + answer[end+2:]
	}
}
