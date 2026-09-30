package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"swyp-lang/internal/ilaria"
	"swyp-lang/internal/swyplang"
	"time"
)

func draftInstructions() string {
	return `Generate only a complete Swyp program for the source surface described below, without Markdown or explanation.
` + generationLanguageSpec() + `If the task needs unavailable capabilities, reply UNSUPPORTED: followed by the missing capability.
No automatic execution occurs. The user's task follows:
`
}

func verifiedDraft(ctx context.Context, backend ilaria.Backend, prompt string) (string, error) {
	reply, err := backend.Chat(ctx, draftInstructions()+prompt, nil)
	if err != nil {
		return "", err
	}
	source := strings.TrimSpace(reply)
	if strings.HasPrefix(source, "UNSUPPORTED:") {
		return "", fmt.Errorf("Ilaria: %s", source)
	}
	if strings.HasPrefix(source, "```") {
		return "", fmt.Errorf("Ilaria returned Markdown instead of source; no draft saved")
	}
	p, err := swyplang.Parse("generated.swyp", source)
	if err != nil {
		return "", fmt.Errorf("generated source rejected: %w", err)
	}
	if err = p.Check(); err != nil {
		return "", fmt.Errorf("generated source rejected: %w", err)
	}
	return "// Generated draft. Static checks passed; behavior has not been verified.\n" + source + "\n", nil
}
func draftCommand(args []string) error {
	f := flag.NewFlagSet("draft", flag.ContinueOnError)
	promptPath := f.String("prompt", "", "UTF-8 task description file")
	out := f.String("o", "", "new .swyp file")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *promptPath == "" || *out == "" || len(f.Args()) != 0 {
		return fmt.Errorf("usage: swyp draft -prompt task.txt -o new-file.swyp")
	}
	prompt, err := os.ReadFile(*promptPath)
	if err != nil {
		return err
	}
	if len(prompt) == 0 || len(prompt) > 32*1024 {
		return fmt.Errorf("prompt must contain 1–32768 bytes")
	}
	if _, err := os.Stat(*out); err == nil {
		return fmt.Errorf("draft output already exists; choose a new file")
	} else if !os.IsNotExist(err) {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	backend, _ := configuredIlariaBackend()
	source, err := verifiedDraft(ctx, backend, string(prompt))
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(source)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	fmt.Println("Saved checked draft:", *out, "(not executed; review behavior before use)")
	return nil
}
