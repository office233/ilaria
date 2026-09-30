package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/componentspec"
)

func componentCommand(args []string, out io.Writer) error {
	if len(args) == 0 || (args[0] != "check" && args[0] != "compile" && args[0] != "go") {
		return fmt.Errorf("usage: swyp component check file.swyp | swyp component compile -o manifest.json file.swyp | swyp component go -package pkg -o types_gen.go file.swyp")
	}
	mode := args[0]
	flags := flag.NewFlagSet("component "+mode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	output := flags.String("o", "", "canonical component manifest destination")
	packageName := flags.String("package", "", "Go package for generated record DTOs")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if len(flags.Args()) != 1 {
		return fmt.Errorf("component %s requires exactly one source file", mode)
	}
	if mode == "check" && (*output != "" || *packageName != "") {
		return fmt.Errorf("component check does not accept -o")
	}
	if mode == "compile" && *output == "" {
		return fmt.Errorf("component compile requires -o new-manifest.json")
	}
	if mode == "compile" && *packageName != "" {
		return fmt.Errorf("component compile does not accept -package")
	}
	if mode == "go" && (*output == "" || *packageName == "") {
		return fmt.Errorf("component go requires -package pkg -o types_gen.go")
	}

	sourcePath := flags.Args()[0]
	source, err := readModuleInput(sourcePath, 1<<20)
	if err != nil {
		return err
	}
	manifest, err := componentspec.Parse(sourcePath, string(source))
	if err != nil {
		return err
	}
	if mode == "check" {
		fmt.Fprintf(out, "Component manifest OK: %d declarations\n", len(manifest.Declarations))
		return nil
	}
	var b []byte
	if mode == "go" {
		b, err = manifest.GoSource(*packageName)
	} else {
		b, err = manifest.CanonicalJSON()
	}
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	payload := b
	if mode != "go" {
		payload = append(payload, '\n')
	}
	if _, err := file.Write(payload); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if mode == "go" {
		fmt.Fprintln(out, "Created Go component types", *output)
	} else {
		fmt.Fprintln(out, "Created component manifest", *output)
	}
	return nil
}
