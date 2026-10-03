package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"swyp-lang/internal/ilaria"
	"swyp-lang/internal/swyplang"
	"time"
)

func intentInstructions() string {
	return `You expand Swyp Lang intent statements, not an entire program.
Reply only with JSON: {"replacements":[{"id":0,"code":"Swyp statements here"}]}.
Return exactly one replacement per directive. Preserve the supplied handwritten code.
Each replacement is a statement fragment in its existing scope, not new top-level functions.
Use surrounding variables and types. Requests may be Romanian or English.
If unavailable capabilities are needed, reply UNSUPPORTED: with the missing capability.
` + draftInstructions()
}

func expandedIntent(ctx context.Context, backend ilaria.Backend, filename, source string) (string, error) {
	intents, err := swyplang.Intents(filename, source)
	if err != nil {
		return "", err
	}
	if len(intents) == 0 {
		return "", fmt.Errorf("no intent directives found")
	}
	payload, err := json.Marshal(struct {
		Source  string            `json:"source"`
		Intents []swyplang.Intent `json:"intents"`
	}{source, intents})
	if err != nil {
		return "", err
	}
	// The fragment response contract overrides the generic full-program wording.
	prompt := intentInstructions() + "\nIMPORTANT: return replacements JSON, not a complete program.\n" + string(payload)
	reply, err := backend.Chat(ctx, prompt, nil)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(strings.TrimSpace(reply), "UNSUPPORTED:") {
		return "", fmt.Errorf("Ilaria: %s", strings.TrimSpace(reply))
	}
	var response struct {
		Replacements []swyplang.Replacement `json:"replacements"`
	}
	decoder := json.NewDecoder(strings.NewReader(reply))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return "", fmt.Errorf("invalid expansion response: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", fmt.Errorf("expansion response has trailing data")
	}
	return swyplang.Expand(filename, source, response.Replacements)
}

// replayBackend is explicitly offline fixture replay, never a model substitute.
type replayBackend struct{ reply string }

func (b replayBackend) Chat(context.Context, string, []ilaria.Message) (string, error) {
	return b.reply, nil
}
func digest(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }

type generationRecord struct {
	Version          string `json:"version"`
	Operation        string `json:"operation"`
	Backend          string `json:"backend"`
	SourceSHA256     string `json:"source_sha256"`
	OutputSHA256     string `json:"output_sha256"`
	Diagnostics      string `json:"original_diagnostics,omitempty"`
	StaticChecks     bool   `json:"static_checks_passed"`
	BehaviorVerified bool   `json:"behavior_verified"`
}

func saveGeneration(path, source string, record generationRecord) error {
	// Exclusive creation prevents overwriting source or a prior expansion.
	manifest, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = file.WriteString(source); err != nil {
		file.Close()
		os.Remove(path)
		return err
	}
	if err = file.Close(); err != nil {
		os.Remove(path)
		return err
	}
	lock, err := os.OpenFile(path+".lock.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		os.Remove(path)
		return err
	}
	_, err = lock.Write(append(manifest, '\n'))
	closeErr := lock.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		os.Remove(path + ".lock.json")
	}
	return err
}

func intentCommand(operation string, args []string) error {
	f := flag.NewFlagSet(operation, flag.ContinueOnError)
	out := f.String("o", "", "new Swyp source file")
	response := f.String("response", "", "explicit offline response fixture (no model call)")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *out == "" || len(f.Args()) != 1 {
		return fmt.Errorf("usage: swyp %s -o new.swyp [-response fixture] input.swyp", operation)
	}
	input := f.Args()[0]
	sourceBytes, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	if len(sourceBytes) > 32768 {
		return fmt.Errorf("AI source exceeds 32 KiB")
	}
	source := string(sourceBytes)
	for _, path := range []string{*out, *out + ".lock.json"} {
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("output already exists: %s", path)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	backend, backendName := configuredIlariaBackend()
	if *response != "" {
		bytes, err := os.ReadFile(*response)
		if err != nil {
			return err
		}
		if len(bytes) > 128*1024 {
			return fmt.Errorf("response fixture exceeds 128 KiB")
		}
		backend = replayBackend{string(bytes)}
		backendName = "OFFLINE FIXTURE REPLAY (not AI generation)"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var generated, diagnostic string
	if operation == "expand" {
		generated, err = expandedIntent(ctx, backend, input, source)
	} else {
		p, checkErr := swyplang.Parse(input, source)
		if checkErr == nil {
			checkErr = p.Check()
		}
		if checkErr == nil {
			return fmt.Errorf("source already passes static checks; repair requires a diagnostic")
		}
		diagnostic = checkErr.Error()
		generated, err = verifiedDraft(ctx, backend, "Repair this source while preserving intended behavior. Only repair what the diagnostic justifies.\nDIAGNOSTIC:\n"+diagnostic+"\nSOURCE:\n"+source)
	}
	if err != nil {
		return err
	}
	generated = "// Swyp " + operation + "; backend: " + backendName + ". Review semantics before use.\n" + generated
	record := generationRecord{Version: swypLanguageVersion, Operation: operation, Backend: backendName, SourceSHA256: digest(source), OutputSHA256: digest(generated), Diagnostics: diagnostic, StaticChecks: true}
	if err = saveGeneration(*out, generated, record); err != nil {
		return err
	}
	fmt.Println("Saved", *out, "and provenance manifest. Static checks passed; behavior unverified.")
	fmt.Println("Backend:", backendName)
	return nil
}
