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
	HIRTypes                []string `json:"hir_types"`
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
		CoreTypes:               []string{"bool", "i64", "u64", "f64", "ieee64", "bytes", "void"},
		HIRTypes:                []string{"bool", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f16", "bf16", "f32", "f64", "finite32", "finite64", "ieee64", "string", "bytes", "array<T,N>", "slice<T>", "vec<T>", "option<T>", "result<T,E>", "tuple<T...>", "opaque<T>", "ref<T>", "mutref<T>", "void"},
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
			"qualified-declaration-hir-v1",
			"nominal-struct-enum-hir-v1",
			"contextual-array-literals-hir-v1",
			"array-index-hir-v1",
			"struct-values-hir-v1",
			"enum-match-hir-v1",
			"slice-views-hir-v1",
			"fixed-layout-planner-v1",
			"option-result-values-hir-v1",
			"affine-ownership-checker-v1",
			"explicit-drop-hir-v1",
			"lexical-borrow-hir-v1",
			"mutable-borrow-store-hir-v1",
			"borrow-lifetime-contract-v1",
			"noncopy-borrow-projection-v1",
			"static-field-place-borrow-v1",
			"constant-index-place-borrow-v1",
			"constant-range-place-borrow-v1",
			"logical-descriptor-abi-v1",
			"bounds-evidence-v1",
			"standalone-native-storage-runtime-v1",
			"fixed-array-core-scalarization-v1",
			"dynamic-fixed-array-bounds-core-v1",
			"fixed-slice-core-scalarization-v1",
			"dynamic-fixed-slice-range-core-v1",
			"core-storage-u64-interpreter-v1",
			"storage-backed-large-array-core-v1",
			"storage-backed-slice-core-v1",
			"storage-backed-vec-u64-core-v1",
			"storage-backed-i64-core-v1",
			"storage-backed-vec-ref-core-v1",
			"vec-push-cfg-core-v1",
			"vec-u64-function-param-abi-v1",
			"vec-raw64-return-handle-abi-v1",
			"deferred-drop-scope-cleanup-v1",
			"flat-struct-vec-storage-v1",
			"flat-struct-slice-storage-v1",
			"struct-storage-field-ref-v1",
			"nested-raw64-struct-storage-v1",
			"deferred-drop-vec-param-v1",
			"raw64-storage-bitcast-v1",
			"fixed-struct-core-scalarization-v1",
			"known-sum-core-scalarization-v1",
			"local-ref-core-alias-v1",
			"typed-body-hir-v1",
			"qualified-import-linking-v1",
			"linked-hir-to-core-v1",
			"linked-hir-native-pack-v1",
			"linked-hir-native-exe-v1",
			"richer-hir-type-model-v1",
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
