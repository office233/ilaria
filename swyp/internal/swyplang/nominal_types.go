package swyplang

import (
	"strings"
	"text/scanner"

	"swyp-lang/internal/hir"
)

func validateProgramTypeNames(p *Program) error {
	if p == nil || !p.core {
		return nil
	}
	uses := map[string]bool{}
	for _, use := range p.uses {
		uses[use] = true
	}
	return validateAllProgramTypes(p, uses)
}

func validateAllProgramTypes(p *Program, uses map[string]bool) error {
	validate := func(text string, pos scanner.Position) error {
		t, err := hir.ParseTypeRef(text)
		if err != nil {
			return diagnosticAt(DiagnosticInvalidType, pos, "%v", err)
		}
		var walk func(hir.TypeRef) error
		walk = func(ref hir.TypeRef) error {
			if len(ref.Args) == 0 {
				name := ref.Name
				if coreHIRScalarType(name) || name == "number" || name == "bool" || name == "string" || name == "void" {
					return nil
				}
				if _, ok := p.structs[name]; ok {
					return nil
				}
				if _, ok := p.enums[name]; ok {
					return nil
				}
				if dot := strings.LastIndex(name, "."); dot > 0 {
					module := name[:dot]
					if uses[module] {
						return nil
					}
					return diagnosticAt(DiagnosticInvalidType, pos, "qualified type %q requires direct use %s", name, module)
				}
				return diagnosticAt(DiagnosticInvalidType, pos, "expected type name; unknown nominal type %q", name)
			}
			for _, arg := range ref.Args {
				if err := walk(arg); err != nil {
					return err
				}
			}
			return nil
		}
		return walk(t)
	}
	for _, d := range p.structs {
		for _, field := range d.fields {
			if err := validate(field.typeName, field.pos); err != nil {
				return err
			}
		}
	}
	for _, d := range p.enums {
		for _, variant := range d.variants {
			if variant.payload != "" {
				if err := validate(variant.payload, variant.pos); err != nil {
					return err
				}
			}
		}
	}
	for _, f := range p.functions {
		for i, typ := range f.annotations {
			if typ != "" {
				if err := validate(typ, f.pos); err != nil {
					return diagnosticAt(DiagnosticInvalidType, f.pos, "parameter %s: %v", f.params[i], err)
				}
			}
		}
		if f.result != "" {
			if err := validate(f.result, f.pos); err != nil {
				return err
			}
		}
		var walkStatements func([]*stmt) error
		walkStatements = func(body []*stmt) error {
			for _, s := range body {
				if s.annotation != "" {
					if err := validate(s.annotation, s.pos); err != nil {
						return err
					}
				}
				if err := walkStatements(s.body); err != nil {
					return err
				}
				if err := walkStatements(s.other); err != nil {
					return err
				}
			}
			return nil
		}
		if err := walkStatements(f.body); err != nil {
			return err
		}
	}
	return nil
}
