package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

const swypLanguageVersion = swyplang.Version

type languageManifest struct {
	SchemaVersion           int      `json:"schema_version"`
	Language                string   `json:"language"`
	Version                 string   `json:"version"`
	SourceExtension         string   `json:"source_extension"`
	DraftSurface            string   `json:"draft_surface"`
	DiagnosticSchemaVersion int      `json:"diagnostic_schema_version"`
	DiagnosticCodes         []string `json:"diagnostic_codes"`
	LegacyTypes             []string `json:"legacy_types"`
	CoreTypes               []string `json:"core_types"`
	Operators               []string `json:"operators"`
	Effects                 []string `json:"effects"`
	Features                []string `json:"features"`
}

func currentLanguageManifest() languageManifest {
	return languageManifest{
		SchemaVersion:           1,
		Language:                "Swyp Lang",
		Version:                 swypLanguageVersion,
		SourceExtension:         ".swyp",
		DraftSurface:            "legacy-scalar",
		DiagnosticSchemaVersion: swyplang.DiagnosticSchemaVersion,
		DiagnosticCodes:         swyplang.CanonicalDiagnosticCodes(),
		LegacyTypes:             []string{"number", "bool", "string", "void"},
		CoreTypes:               []string{"bool", "i64", "u64", "f64", "ieee64", "void"},
		Operators:               []string{"+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "!", "&&", "||", "&", "|", "^", "<<", ">>"},
		Effects:                 coreir.CanonicalEffectRegistry(),
		Features: []string{
			"semantic-core-ir",
			"contracts",
			"counterexample-verification",
			"deterministic-synthesis",
			"stable-source-diagnostics-v1",
			"shared-module-use-preamble-v1",
			"deterministic-module-graph-v1",
			"effect-capability-metadata",
			"ssa",
			"native-x86-64",
			"native-arm64",
			"turbo-bytecode",
			"stv2-swypb",
			"component-specs",
		},
	}
}

func generationLanguageSpec() string {
	m := currentLanguageManifest()
	return fmt.Sprintf(`Current compiler: Swyp Lang %s.
The AI draft/intent path currently targets the legacy-scalar source surface only.
Types on this surface: %s. Variables have fixed inferred or annotated types.
Syntax: fn main() { let x = 1; print(x); } Functions use fn name(x: number) -> number { return x * x; }.
Operators on this surface: + - * / %% == != < <= > >= ! && ||. Control flow: if/else, while, return, assignment.
Builtins: print(values...), arg(index) for numeric CLI arguments, clock() for interval timing.
Do not emit Semantic Core-only types, arrays, imports, filesystem, HTTP, email, model-training libraries, or invented APIs on this path.
`, m.Version, strings.Join(m.LegacyTypes, ", "))
}

func languageManifestCommand(out io.Writer) error {
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(currentLanguageManifest())
}
