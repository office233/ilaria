package cortex

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Verified code generation: the model writes a Swyp function, `swyp judge`
// checks it against a contract, and a rejection (counterexample, compile
// error) goes back to the model as the next user turn until the verifier
// accepts or the round budget runs out. The runtime does the verification
// call itself, so this works with a base model that was never trained to
// emit "CALL <tool>: ..." lines.

// SwypGenerator produces the model's reply to one prompt. Every prompt the
// loop sends is self-contained (task, signature and any rejected attempt
// with its verdict), so a generator may start each call from a fresh
// context; with greedy decoding that avoids copying the previous reply.
type SwypGenerator func(ctx context.Context, userText string) (string, error)

// SwypVerifier checks one candidate source against the contract.
type SwypVerifier func(ctx context.Context, source string, contract json.RawMessage) (SwypVerdict, error)

type SwypAttempt struct {
	Round   int          `json:"round"`
	Reply   string       `json:"reply"`
	Source  string       `json:"source,omitempty"`
	Verdict *SwypVerdict `json:"verdict,omitempty"`
	Note    string       `json:"note,omitempty"`
}

type SwypSolveReport struct {
	Version   int           `json:"version"`
	Task      string        `json:"task"`
	Signature string        `json:"signature"`
	Status    string        `json:"status"` // "verified" or "unverified"
	Source    string        `json:"source,omitempty"`
	Verdict   *SwypVerdict  `json:"verdict,omitempty"`
	Attempts  []SwypAttempt `json:"attempts"`
}

type swypContractShape struct {
	Entry  string `json:"entry"`
	Inputs []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"inputs"`
}

var swypIdent = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// SwypSignature derives "fn entry(a: i64, b: i64) -> i64" from a contract.
// The result type is taken from the first input, the only shape Swyp
// contracts currently describe.
func SwypSignature(contract json.RawMessage) (entry, signature string, err error) {
	var c swypContractShape
	if err := json.Unmarshal(contract, &c); err != nil {
		return "", "", fmt.Errorf("contract: %w", err)
	}
	if !swypIdent.MatchString(c.Entry) || len(c.Inputs) == 0 {
		return "", "", fmt.Errorf("contract needs an identifier entry and at least one input")
	}
	params := make([]string, len(c.Inputs))
	for i, in := range c.Inputs {
		if !swypIdent.MatchString(in.Name) || (in.Type != "i64" && in.Type != "f64") {
			return "", "", fmt.Errorf("contract input %d must be a named i64 or f64", i)
		}
		params[i] = in.Name + ": " + in.Type
	}
	return c.Entry, fmt.Sprintf("fn %s(%s) -> %s", c.Entry, strings.Join(params, ", "), c.Inputs[0].Type), nil
}

var swypFence = regexp.MustCompile("(?s)```[A-Za-z]*\\s*\\n(.*?)```")

// ExtractSwypFunction finds the function named entry in a model reply:
// inside a fenced block when there is one, otherwise in the bare text. It
// returns the text from "fn entry" through the brace that closes its body.
func ExtractSwypFunction(reply, entry string) (string, bool) {
	candidates := []string{}
	for _, m := range swypFence.FindAllStringSubmatch(reply, -1) {
		candidates = append(candidates, m[1])
	}
	candidates = append(candidates, reply)
	head := regexp.MustCompile(`\bfn\s+` + regexp.QuoteMeta(entry) + `\s*\(`)
	for _, text := range candidates {
		loc := head.FindStringIndex(text)
		if loc == nil {
			continue
		}
		open := strings.IndexByte(text[loc[0]:], '{')
		if open < 0 {
			continue
		}
		depth := 0
		for i := loc[0] + open; i < len(text); i++ {
			switch text[i] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					return strings.TrimSpace(text[loc[0] : i+1]), true
				}
			}
		}
	}
	return "", false
}

var swypFnName = regexp.MustCompile(`\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(`)

// RenameSoleSwypFunction handles a reply whose code is right but whose
// function name is not the contract's entry (observed live: "greater_than"
// for "above"). If the reply defines exactly one function other than main,
// it is extracted and renamed — calls included, for recursion — to entry.
// The rename is reported, and the renamed code is still fully verified.
func RenameSoleSwypFunction(reply, entry string) (source, renamedFrom string, ok bool) {
	names := map[string]bool{}
	for _, m := range swypFnName.FindAllStringSubmatch(reply, -1) {
		if m[1] != "main" {
			names[m[1]] = true
		}
	}
	if len(names) != 1 {
		return "", "", false
	}
	for name := range names {
		renamedFrom = name
	}
	source, ok = ExtractSwypFunction(reply, renamedFrom)
	if !ok {
		return "", "", false
	}
	calls := regexp.MustCompile(`\b` + regexp.QuoteMeta(renamedFrom) + `(\s*\()`)
	return calls.ReplaceAllString(source, entry+"$1"), renamedFrom, true
}

// A single tiny example: a longer grammar summary gets copied verbatim by a
// small model (observed live: it pasted "while cond" and "if cond" into its
// answer).
const swypSyntaxHint = "Example of Swyp: fn double(x: i64) -> i64 { return x + x; }"

// SolveWithSwyp runs the generate → verify → repair loop for at most
// rounds model replies. It returns an error only for infrastructure
// failures (model or verifier unusable); running out of rounds is a normal
// "unverified" report.
func SolveWithSwyp(ctx context.Context, task string, contract json.RawMessage, rounds int, generate SwypGenerator, verify SwypVerifier) (SwypSolveReport, error) {
	entry, signature, err := SwypSignature(contract)
	if err != nil {
		return SwypSolveReport{}, err
	}
	if rounds < 1 || rounds > 16 {
		return SwypSolveReport{}, fmt.Errorf("rounds must be 1..16")
	}
	report := SwypSolveReport{Version: 1, Task: task, Signature: signature, Status: "unverified"}
	prompt := fmt.Sprintf("%s\nWrite it as one Swyp function with exactly this signature: %s\n%s\nReply with only the function inside a ```swyp code block.",
		strings.TrimSpace(task), signature, swypSyntaxHint)
	for round := 1; round <= rounds; round++ {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		reply, err := generate(ctx, prompt)
		if err != nil {
			return report, fmt.Errorf("round %d: generate: %w", round, err)
		}
		attempt := SwypAttempt{Round: round, Reply: truncateForTool(reply, 2000)}
		source, ok := ExtractSwypFunction(reply, entry)
		if !ok {
			var from string
			if source, from, ok = RenameSoleSwypFunction(reply, entry); ok {
				attempt.Note = "renamed " + from + " to " + entry
			}
		}
		if !ok {
			attempt.Note = "no function named " + entry + " in reply"
			report.Attempts = append(report.Attempts, attempt)
			prompt = fmt.Sprintf("%s\nWrite it as one Swyp function named %s with exactly this signature: %s\n%s\nReply with only the function inside a ```swyp code block.",
				strings.TrimSpace(task), entry, signature, swypSyntaxHint)
			continue
		}
		attempt.Source = source
		verdict, err := verify(ctx, source, contract)
		if err != nil {
			report.Attempts = append(report.Attempts, attempt)
			return report, fmt.Errorf("round %d: verify: %w", round, err)
		}
		attempt.Verdict = &verdict
		report.Attempts = append(report.Attempts, attempt)
		if verdict.Accepted() {
			report.Status, report.Source, report.Verdict = "verified", source, &verdict
			return report, nil
		}
		// Quote the rejected code and the verdict: a greedy decoder otherwise
		// tends to reproduce its previous reply unchanged.
		prompt = fmt.Sprintf("This Swyp function is wrong:\n```swyp\n%s\n```\nThe verifier says: %s\nTask: %s\nWrite a different, corrected function %s { ... }. Reply with only the function inside a ```swyp code block.",
			source, verdict.Summary, strings.TrimSpace(task), signature)
	}
	return report, nil
}
