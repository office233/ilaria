package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hircore"
)

func hirCoreCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-core", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root; a.b resolves to <root>/a/b.swyp")
	entry := flags.String("entry", "main", "root-module function lowered as the Core entry")
	output := flags.String("o", "", "optional new Core IR JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *entry == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-core requires -root DIR [-entry fn] and exactly one root source file")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	lowered, err := hircore.Lower(bundle, *entry)
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(lowered.Module)
	if err != nil {
		return err
	}
	irHash := coreHash(canonical)
	payload, err := json.MarshalIndent(lowered.Module, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(struct {
			Version  int               `json:"version"`
			Path     string            `json:"path"`
			Entry    string            `json:"entry"`
			IRSHA256 string            `json:"ir_sha256"`
			Symbols  map[string]string `json:"symbols"`
		}{1, *output, lowered.Entry, irHash, lowered.Symbols})
	}
	_, err = out.Write(payload)
	return err
}
