package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"time"

	"swyp-lang/internal/sourcefront"
)

func moduleGraphCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("module-graph", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root; a.b resolves to <root>/a/b.swyp")
	output := flags.String("o", "", "optional new JSON output file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 1 {
		return fmt.Errorf("module-graph requires -root DIR and exactly one root source file")
	}
	inputPath := flags.Arg(0)
	rootSource, err := readModuleInput(inputPath, sourcefront.MaxModuleSourceBytes)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	graph, err := sourcefront.ResolveGraph(ctx, inputPath, rootSource, sourcefront.FSLoader{Root: *root})
	if err != nil {
		return err
	}
	payload, err := json.MarshalIndent(graph, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		sum := sha256.Sum256(payload)
		_, err := fmt.Fprintf(out, "Created module graph %s sha256=%s\n", *output, hex.EncodeToString(sum[:]))
		return err
	}
	_, err = out.Write(payload)
	return err
}
