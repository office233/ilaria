package hircore

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hir"
	"swyp-lang/internal/swyplang"
)

func boolStorageProfiles(executable *coreir.Executable) map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error) {
	return map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error){
		"run": executable.Run, "fast": executable.RunFast, "turbo": executable.RunTurbo,
	}
}

func TestLowerStorageVecBool(t *testing.T) {
	source := `module app.main;
fn run(i: u64, flag: bool) -> bool {
    let v: vec<bool> = [false, flag];
    let x: bool = v[i];
    drop(v);
    return x;
}`
	p, err := swyplang.ParseCoreModule("vec-bool.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index uint64
		flag  bool
		want  bool
	}{{0, false, false}, {0, true, false}, {1, false, false}, {1, true, true}} {
		got, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(tc.index), coreir.Boolean(tc.flag)}, 10000)
		if err != nil {
			t.Fatal(err)
		}
		value, ok := got.Value.Boolean()
		if !ok || value != tc.want {
			t.Fatalf("index=%d flag=%v: value=%v want=%v", tc.index, tc.flag, got.Value, tc.want)
		}
	}
	if _, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(2), coreir.Boolean(true)}, 10000); err == nil {
		t.Fatal("bool vec OOB unexpectedly succeeded")
	}
}

func TestStorageBoolCodecCanonicalWords(t *testing.T) {
	boolean := hir.TypeRef{Name: "bool"}
	for _, encode := range []bool{true, false} {
		t.Run("encode="+strconv.FormatBool(encode), func(t *testing.T) {
			input, output := coreir.U64, coreir.Bool
			if encode {
				input, output = coreir.Bool, coreir.U64
			}
			b := builder{f: coreir.Function{
				Name: "codec", Params: []coreir.Parameter{{Name: "value", Type: input}},
				Slots: []coreir.Type{input}, Result: output,
			}}
			if _, err := b.newBlock(); err != nil {
				t.Fatal(err)
			}
			var dest int
			var err error
			if encode {
				dest, err = b.encodeStorageScalar(0, boolean, hir.Location{})
			} else {
				dest, err = b.decodeStorageScalar(0, boolean, hir.Location{})
			}
			if err != nil {
				t.Fatal(err)
			}
			b.terminate(coreir.Terminator{Op: "return", Value: dest})
			executable, err := coreir.Prepare(coreir.Module{Version: coreir.Version, Functions: []coreir.Function{b.f}})
			if err != nil {
				t.Fatal(err)
			}
			for name, run := range boolStorageProfiles(executable) {
				t.Run(name, func(t *testing.T) {
					for _, raw := range []uint64{0, 1, 2, 255, 1 << 63, ^uint64(0)} {
						if encode && raw > 1 {
							continue
						}
						value := coreir.Uint(raw)
						if encode {
							value = coreir.Boolean(raw == 1)
						}
						got, err := run(context.Background(), "codec", []coreir.Value{value}, 10000)
						if !encode && raw > 1 {
							var diagnostic *coreir.Diagnostic
							if !errors.As(err, &diagnostic) || diagnostic.Code != "unreachable" {
								t.Fatalf("noncanonical word %d: result=%v error=%v, want checked unreachable trap", raw, got.Value, err)
							}
							continue
						}
						if err != nil {
							t.Fatal(err)
						}
						if encode {
							word, ok := got.Value.Uint64()
							if !ok || word != raw {
								t.Fatalf("encode %v: word=%d type=%s want=%d", value, word, got.Value.Type(), raw)
							}
						} else {
							flag, ok := got.Value.Boolean()
							if !ok || flag != (raw == 1) {
								t.Fatalf("decode %d: result=%v", raw, got.Value)
							}
						}
					}
				})
			}
		})
	}
}

func TestStorageBoolCodecRejectsUntypedConversions(t *testing.T) {
	for _, typ := range []coreir.Type{coreir.U64, coreir.I64, coreir.IEEE64, coreir.Bool} {
		b := builder{f: coreir.Function{Slots: []coreir.Type{typ}}}
		if typ != coreir.Bool {
			if _, err := b.encodeStorageScalar(0, hir.TypeRef{Name: "bool"}, hir.Location{}); err == nil {
				t.Fatalf("encoded %s as bool without a typed bool source", typ)
			}
		}
		if typ != coreir.U64 {
			if _, err := b.decodeStorageScalar(0, hir.TypeRef{Name: "bool"}, hir.Location{}); err == nil {
				t.Fatalf("decoded %s as a raw storage word", typ)
			}
		}
	}
	for _, slot := range []int{-1, 1} {
		b := builder{f: coreir.Function{Slots: []coreir.Type{coreir.Bool}}}
		if _, err := b.encodeStorageScalar(slot, hir.TypeRef{Name: "bool"}, hir.Location{}); err == nil {
			t.Fatalf("encoded invalid slot %d", slot)
		}
		if _, err := b.decodeStorageScalar(slot, hir.TypeRef{Name: "bool"}, hir.Location{}); err == nil {
			t.Fatalf("decoded invalid slot %d", slot)
		}
	}
}

func TestStorageBoolLayoutUsesRaw64Words(t *testing.T) {
	p, err := swyplang.ParseCoreModule("layout-bool.swyp", `module app.main;
struct Bits { on: bool; code: u64; }
struct Outer { off: bool; bits: Bits; count: i64; ratio: ieee64; }`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range m.Declarations {
		if m.Declarations[i].ID.Name == "Bits" {
			m.Declarations[i].ID.Kind = "record"
		}
	}
	types, err := hir.BuildTypeTable([]hir.Module{m})
	if err != nil {
		t.Fatal(err)
	}
	layout, err := storageElementLayoutFor(types, m.Name, hir.TypeRef{Name: "Outer"})
	if err != nil {
		t.Fatal(err)
	}
	if layout.words != 5 || len(layout.fields) != 5 || layout.flat {
		t.Fatalf("layout=%+v", layout)
	}
	for i, want := range []string{"off:bool", "bits.on:bool", "bits.code:u64", "count:i64", "ratio:ieee64"} {
		field := layout.fields[i]
		if got := strings.Join(field.path, ".") + ":" + field.typ.String(); got != want || field.word != uint64(i) {
			t.Fatalf("field[%d]=%+v want=%s at word %d", i, field, want, i)
		}
	}
	for _, typ := range []hir.TypeRef{{Name: "bool"}, {Name: "Bits"}} {
		layout, err := storageElementLayoutFor(types, m.Name, typ)
		if err != nil || !layout.flat {
			t.Fatalf("flat layout %s: %+v error=%v", typ.String(), layout, err)
		}
	}
	descriptor, err := hir.PlanDescriptor(
		hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}},
		m.Name, hir.TypeRef{Name: "vec", Args: []hir.TypeRef{{Name: "bool"}}},
	)
	if err != nil || descriptor.ElementSize != 1 || descriptor.ElementStride != 1 {
		t.Fatalf("logical fixed bool layout changed: descriptor=%+v error=%v", descriptor, err)
	}
	for _, typ := range []hir.TypeRef{
		{Name: "f64"}, {Name: "bytes"}, {Name: "string"},
		{Name: "option", Args: []hir.TypeRef{{Name: "bool"}}},
	} {
		if _, err := storageElementLayoutFor(types, m.Name, typ); err == nil {
			t.Fatalf("unsupported storage leaf %s was promoted", typ.String())
		}
	}
}
