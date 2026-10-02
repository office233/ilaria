package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"time"

	"swyp-lang/internal/componentspec"
	"swyp-lang/internal/hir"
	"swyp-lang/internal/sourcefront"
	"swyp-lang/internal/swyplang"
)

type hirParsedSource struct {
	resolved sourcefront.ResolvedModule
	program  *swyplang.Program
	decls    hir.Module
}

func hirLinkCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-link", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root; a.b resolves to <root>/a/b.swyp")
	output := flags.String("o", "", "optional new linked HIR bundle JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-link requires -root DIR and exactly one root source file")
	}
	rootPath := flags.Arg(0)
	bundle, err := buildHIRBundle(rootPath, *root)
	if err != nil {
		return err
	}
	payload, err := bundle.CanonicalJSON()
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "Created linked HIR", *output)
		return err
	}
	_, err = out.Write(payload)
	return err
}

func buildHIRBundle(rootPath, root string) (hir.Bundle, error) {
	rootSource, err := readModuleInput(rootPath, sourcefront.MaxModuleSourceBytes)
	if err != nil {
		return hir.Bundle{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	graph, sources, err := sourcefront.ResolveModules(ctx, rootPath, rootSource, sourcefront.FSLoader{Root: root})
	if err != nil {
		return hir.Bundle{}, err
	}
	parsed := make([]hirParsedSource, 0, len(sources))
	declModules := make([]hir.Module, 0, len(sources))
	for _, source := range sources {
		item, err := parseHIRLinkSource(source)
		if err != nil {
			return hir.Bundle{}, fmt.Errorf("module %s: %w", source.Name, err)
		}
		parsed = append(parsed, item)
		declModules = append(declModules, item.decls)
	}
	table, err := hir.BuildFunctionTable(declModules)
	if err != nil {
		return hir.Bundle{}, err
	}
	types, err := hir.BuildTypeTable(declModules)
	if err != nil {
		return hir.Bundle{}, err
	}
	bundle := hir.Bundle{Version: hir.Version, Root: graph.Root, Modules: make([]hir.Module, 0, len(parsed))}
	for _, item := range parsed {
		module := item.decls
		if item.program != nil {
			module, err = item.program.HIRModule(table, types)
			if err != nil {
				return hir.Bundle{}, fmt.Errorf("module %s: %w", item.resolved.Name, err)
			}
		}
		bundle.Modules = append(bundle.Modules, module)
	}
	if err := bundle.Validate(); err != nil {
		return hir.Bundle{}, err
	}
	return bundle, nil
}

func parseHIRLinkSource(source sourcefront.ResolvedModule) (hirParsedSource, error) {
	first, err := sourcefront.FirstBodyToken(source.Name+".swyp", string(source.Source))
	if err != nil {
		return hirParsedSource{}, err
	}
	item := hirParsedSource{resolved: source}
	switch {
	case executableHIRDeclarationKind(first):
		// Linked executable modules use the Core parser so every cross-module
		// signature has deterministic semantic types; untyped legacy inference
		// remains supported by single-module `swyp hir` only.
		program, err := swyplang.ParseCoreModule(source.Name+".swyp", string(source.Source))
		if err != nil {
			return hirParsedSource{}, err
		}
		decls, err := program.HIRDeclarations()
		if err != nil {
			return hirParsedSource{}, err
		}
		item.program, item.decls = program, decls
	case componentDeclarationKinds[first]:
		manifest, err := componentspec.Parse(source.Name+".swyp", string(source.Source))
		if err != nil {
			return hirParsedSource{}, err
		}
		decls, err := manifest.HIRDeclarations()
		if err != nil {
			return hirParsedSource{}, err
		}
		item.decls = decls
	default:
		return hirParsedSource{}, fmt.Errorf("HIR linker cannot classify first declaration %q", first)
	}
	if item.decls.Name != source.Name {
		return hirParsedSource{}, fmt.Errorf("HIR module name %q does not match graph module %q", item.decls.Name, source.Name)
	}
	return item, nil
}
