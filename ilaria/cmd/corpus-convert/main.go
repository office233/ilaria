package main

import (
	"bufio"
	"encoding/json"
	"fmt"
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
	if len(os.Args) < 3 {
		fmt.Println("Usage: corpus-convert <input.jsonl> <output.jsonl>")
		os.Exit(1)
	}

	inFile, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Printf("Error opening input: %v\n", err)
		os.Exit(1)
	}
	defer inFile.Close()

	outFile, err := os.Create(os.Args[2])
	if err != nil {
		fmt.Printf("Error creating output: %v\n", err)
		os.Exit(1)
	}
	defer outFile.Close()

	writer := bufio.NewWriter(outFile)
	defer writer.Flush()

	scanner := bufio.NewScanner(inFile)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

	converted := 0
	skipped := 0

	for scanner.Scan() {
		var raw RawItem
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			skipped++
			continue
		}

		var out CanonicalItem

		// Determine format and convert
		switch {
		case raw.Instruction != "" && raw.Response != "":
			// Already in our format
			out.Instruction = raw.Instruction
			out.Response = raw.Response

		case raw.Question != "" && raw.Answer != "":
			// GSM8K format: clean up the answer
			answer := raw.Answer
			// Remove <<calculation>> markers
			for strings.Contains(answer, "<<") {
				start := strings.Index(answer, "<<")
				end := strings.Index(answer, ">>")
				if end > start {
					answer = answer[:start] + answer[end+2:]
				} else {
					break
				}
			}
			// Clean up #### final answer marker
			answer = strings.TrimSpace(answer)
			
			out.Instruction = raw.Question
			out.Response = "Let me solve this step by step. " + answer

		case raw.Prompt != "" && raw.Completion != "":
			out.Instruction = raw.Prompt
			out.Response = raw.Completion

		case raw.Text != "":
			out.Text = raw.Text

		case raw.Content != "":
			out.Text = raw.Content

		default:
			skipped++
			continue
		}

		data, err := json.Marshal(out)
		if err != nil {
			skipped++
			continue
		}
		writer.Write(data)
		writer.WriteByte('\n')
		converted++
	}

	fmt.Printf("✅ Converted %d items (%d skipped) → %s\n", converted, skipped, os.Args[2])
}
