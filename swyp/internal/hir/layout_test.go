package hir

import (
	"strings"
	"testing"
)

func TestFixedLayoutStructArrayAndEnum(t *testing.T) {
	u8 := TypeRef{Name: "u8"}
	u64 := TypeRef{Name: "u64"}
	three := uint64(3)
	bytes3 := TypeRef{Name: "array", Args: []TypeRef{u8}, Length: &three}
	packet := Declaration{ID: SymbolID{Module: "wire.types", Kind: "struct", Name: "Packet"}, Fields: []Field{
		{Name: "kind", Type: u8},
		{Name: "id", Type: u64},
		{Name: "tag", Type: bytes3},
	}}
	result := Declaration{ID: SymbolID{Module: "wire.types", Kind: "enum", Name: "Result"}, Variants: []Variant{
		{Name: "Missing"},
		{Name: "Found", Payload: &u64},
		{Name: "Packet", Payload: &TypeRef{Name: "Packet"}},
	}}
	module := Module{Version: Version, Name: "wire.types", Declarations: []Declaration{packet, result}}
	bundle := Bundle{Version: Version, Root: "wire.types", Modules: []Module{module}}

	packetLayout, err := PlanFixedLayout(bundle, "wire.types", TypeRef{Name: "Packet"})
	if err != nil {
		t.Fatal(err)
	}
	if packetLayout.ABI != FixedLayoutABI || packetLayout.Size != 24 || packetLayout.Align != 8 || len(packetLayout.Fields) != 3 {
		t.Fatalf("packet layout=%+v", packetLayout)
	}
	if packetLayout.Fields[0].Offset != 0 || packetLayout.Fields[1].Offset != 8 || packetLayout.Fields[2].Offset != 16 {
		t.Fatalf("packet field offsets=%+v", packetLayout.Fields)
	}

	resultLayout, err := PlanFixedLayout(bundle, "wire.types", TypeRef{Name: "Result"})
	if err != nil {
		t.Fatal(err)
	}
	if resultLayout.Size != 32 || resultLayout.Align != 8 || resultLayout.TagSize != 4 || resultLayout.PayloadOffset != 8 || len(resultLayout.Variants) != 3 {
		t.Fatalf("enum layout=%+v", resultLayout)
	}
	if resultLayout.Variants[0].Tag != 0 || resultLayout.Variants[1].Tag != 1 || resultLayout.Variants[2].Tag != 2 {
		t.Fatalf("enum tags=%+v", resultLayout.Variants)
	}
}

func TestFixedLayoutRejectsDynamicAndRecursiveValues(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	node := Declaration{ID: SymbolID{Module: "types", Kind: "struct", Name: "Node"}, Fields: []Field{{Name: "value", Type: u64}, {Name: "next", Type: TypeRef{Name: "Node"}}}}
	module := Module{Version: Version, Name: "types", Declarations: []Declaration{node}}
	bundle := Bundle{Version: Version, Root: "types", Modules: []Module{module}}
	if _, err := PlanFixedLayout(bundle, "types", TypeRef{Name: "Node"}); err == nil || !strings.Contains(err.Error(), "recursive-by-value") {
		t.Fatalf("recursive layout error=%v", err)
	}
	for _, typ := range []TypeRef{
		{Name: "slice", Args: []TypeRef{u64}},
		{Name: "bytes"},
		{Name: "option", Args: []TypeRef{u64}},
	} {
		if _, err := PlanFixedLayout(Bundle{Version: Version, Root: "types", Modules: []Module{{Version: Version, Name: "types"}}}, "types", typ); err == nil || !strings.Contains(err.Error(), "undefined until ownership/descriptor ABI") {
			t.Fatalf("dynamic type %s layout error=%v", typ.String(), err)
		}
	}
}

func TestFixedLayoutRequiresDirectUseForQualifiedNominal(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	lib := Module{Version: Version, Name: "lib.types", Declarations: []Declaration{{ID: SymbolID{Module: "lib.types", Kind: "struct", Name: "User"}, Fields: []Field{{Name: "id", Type: u64}}}}}
	app := Module{Version: Version, Name: "app.main", Uses: []string{"lib.types"}}
	bundle := Bundle{Version: Version, Root: "app.main", Modules: []Module{app, lib}}
	if _, err := PlanFixedLayout(bundle, "app.main", TypeRef{Name: "lib.types.User"}); err != nil {
		t.Fatal(err)
	}
	app.Uses = nil
	bundle.Modules[0] = app
	if _, err := PlanFixedLayout(bundle, "app.main", TypeRef{Name: "lib.types.User"}); err == nil || !strings.Contains(err.Error(), "requires direct use lib.types") {
		t.Fatalf("direct use layout error=%v", err)
	}
}
