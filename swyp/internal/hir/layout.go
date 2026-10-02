package hir

import (
	"fmt"
	"math"
	"strings"
)

// FixedLayoutABI is a compiler-owned logical layout contract for fixed-size
// HIR values. It is intentionally not the platform C ABI and does not define
// ownership, pointer, slice, string, bytes, vec, opaque or foreign-handle layout.
const FixedLayoutABI = "swyp-fixed-v1"

type Layout struct {
	ABI           string          `json:"abi"`
	Type          string          `json:"type"`
	Kind          string          `json:"kind"`
	Size          uint64          `json:"size"`
	Align         uint64          `json:"align"`
	Length        uint64          `json:"length,omitempty"`
	Element       string          `json:"element,omitempty"`
	ElementStride uint64          `json:"element_stride,omitempty"`
	Fields        []FieldLayout   `json:"fields,omitempty"`
	TagSize       uint64          `json:"tag_size,omitempty"`
	PayloadOffset uint64          `json:"payload_offset,omitempty"`
	Variants      []VariantLayout `json:"variants,omitempty"`
}

type FieldLayout struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Offset uint64 `json:"offset"`
	Size   uint64 `json:"size"`
	Align  uint64 `json:"align"`
}

type VariantLayout struct {
	Name         string `json:"name"`
	Tag          uint32 `json:"tag"`
	PayloadType  string `json:"payload_type,omitempty"`
	PayloadSize  uint64 `json:"payload_size,omitempty"`
	PayloadAlign uint64 `json:"payload_align,omitempty"`
}

// PlanFixedLayout computes layout only for values whose representation is fully
// fixed by FixedLayoutABI. The bundle must already be semantically valid; this
// function revalidates it to make standalone callers fail closed.
func PlanFixedLayout(bundle Bundle, currentModule string, typ TypeRef) (Layout, error) {
	if err := bundle.Validate(); err != nil {
		return Layout{}, fmt.Errorf("validate HIR bundle: %w", err)
	}
	if currentModule == "" {
		return Layout{}, fmt.Errorf("layout requires current module")
	}
	var current *Module
	for i := range bundle.Modules {
		if bundle.Modules[i].Name == currentModule {
			current = &bundle.Modules[i]
			break
		}
	}
	if current == nil {
		return Layout{}, fmt.Errorf("layout current module %q is missing from bundle", currentModule)
	}
	if err := validateLayoutReference(*current, typ); err != nil {
		return Layout{}, err
	}
	table, err := BuildTypeTable(bundle.Modules)
	if err != nil {
		return Layout{}, err
	}
	planner := layoutPlanner{types: table, visiting: map[string]bool{}}
	return planner.plan(currentModule, typ)
}

func validateLayoutReference(current Module, typ TypeRef) error {
	uses := map[string]bool{}
	for _, use := range current.Uses {
		uses[use] = true
	}
	var walk func(TypeRef) error
	walk = func(t TypeRef) error {
		for _, arg := range t.Args {
			if err := walk(arg); err != nil {
				return err
			}
		}
		if len(t.Args) != 0 || fixedScalarLayoutKnown(t.Name) {
			return nil
		}
		if dot := strings.LastIndex(t.Name, "."); dot > 0 {
			owner := t.Name[:dot]
			if owner != current.Name && !uses[owner] {
				return fmt.Errorf("layout type %s requires direct use %s", t.Name, owner)
			}
		}
		return nil
	}
	return walk(typ)
}

type layoutPlanner struct {
	types    TypeTable
	visiting map[string]bool
}

func (p *layoutPlanner) plan(currentModule string, typ TypeRef) (Layout, error) {
	if err := ValidateTypeRef(typ); err != nil {
		return Layout{}, err
	}
	if size, align, ok := fixedScalarLayout(typ.Name); ok && len(typ.Args) == 0 && typ.Length == nil {
		return Layout{ABI: FixedLayoutABI, Type: typ.String(), Kind: "scalar", Size: size, Align: align}, nil
	}
	if typ.Name == "array" {
		if len(typ.Args) != 1 || typ.Length == nil {
			return Layout{}, fmt.Errorf("array layout requires array<T,N>")
		}
		element, err := p.plan(currentModule, typ.Args[0])
		if err != nil {
			return Layout{}, fmt.Errorf("array element %s: %w", typ.Args[0].String(), err)
		}
		stride, err := alignUp(element.Size, element.Align)
		if err != nil {
			return Layout{}, err
		}
		size, ok := checkedMul(stride, *typ.Length)
		if !ok {
			return Layout{}, fmt.Errorf("array layout size overflow for %s", typ.String())
		}
		return Layout{
			ABI: FixedLayoutABI, Type: typ.String(), Kind: "array", Size: size, Align: element.Align,
			Length: *typ.Length, Element: typ.Args[0].String(), ElementStride: stride,
		}, nil
	}
	if typ.Name == "slice" || typ.Name == "vec" || typ.Name == "string" || typ.Name == "bytes" || typ.Name == "opaque" || typ.Name == "option" || typ.Name == "result" || typ.Name == "tuple" || typ.Name == "ref" || typ.Name == "mutref" {
		return Layout{}, fmt.Errorf("fixed layout for %s is undefined until ownership/descriptor ABI is specified", typ.String())
	}
	symbol, ok := ResolveType(p.types, currentModule, typ)
	if !ok {
		return Layout{}, fmt.Errorf("unknown fixed-layout type %s", typ.String())
	}
	key := symbol.ID.Module + "." + symbol.ID.Name
	if p.visiting[key] {
		return Layout{}, fmt.Errorf("recursive-by-value type %s has infinite layout", key)
	}
	p.visiting[key] = true
	defer delete(p.visiting, key)
	switch symbol.ID.Kind {
	case "struct", "record":
		return p.planStruct(symbol)
	case "enum":
		return p.planEnum(symbol)
	default:
		return Layout{}, fmt.Errorf("type %s kind %s has no fixed layout", typ.String(), symbol.ID.Kind)
	}
}

func (p *layoutPlanner) planStruct(symbol TypeSymbol) (Layout, error) {
	offset, maxAlign := uint64(0), uint64(1)
	fields := make([]FieldLayout, 0, len(symbol.Fields))
	for _, field := range symbol.Fields {
		layout, err := p.plan(symbol.ID.Module, field.Type)
		if err != nil {
			return Layout{}, fmt.Errorf("field %s: %w", field.Name, err)
		}
		offset, err = alignUp(offset, layout.Align)
		if err != nil {
			return Layout{}, err
		}
		fields = append(fields, FieldLayout{Name: field.Name, Type: field.Type.String(), Offset: offset, Size: layout.Size, Align: layout.Align})
		if offset > math.MaxUint64-layout.Size {
			return Layout{}, fmt.Errorf("struct %s size overflow", symbol.ID.Name)
		}
		offset += layout.Size
		if layout.Align > maxAlign {
			maxAlign = layout.Align
		}
	}
	size, err := alignUp(offset, maxAlign)
	if err != nil {
		return Layout{}, err
	}
	return Layout{ABI: FixedLayoutABI, Type: symbol.ID.Module + "." + symbol.ID.Name, Kind: symbol.ID.Kind, Size: size, Align: maxAlign, Fields: fields}, nil
}

func (p *layoutPlanner) planEnum(symbol TypeSymbol) (Layout, error) {
	const tagSize, tagAlign = uint64(4), uint64(4)
	maxPayloadSize, maxPayloadAlign := uint64(0), uint64(1)
	variants := make([]VariantLayout, 0, len(symbol.Variants))
	for i, variant := range symbol.Variants {
		if uint64(i) > math.MaxUint32 {
			return Layout{}, fmt.Errorf("enum %s has too many variants for u32 tag", symbol.ID.Name)
		}
		v := VariantLayout{Name: variant.Name, Tag: uint32(i)}
		if variant.Payload != nil {
			layout, err := p.plan(symbol.ID.Module, *variant.Payload)
			if err != nil {
				return Layout{}, fmt.Errorf("variant %s: %w", variant.Name, err)
			}
			v.PayloadType, v.PayloadSize, v.PayloadAlign = variant.Payload.String(), layout.Size, layout.Align
			if layout.Size > maxPayloadSize {
				maxPayloadSize = layout.Size
			}
			if layout.Align > maxPayloadAlign {
				maxPayloadAlign = layout.Align
			}
		}
		variants = append(variants, v)
	}
	payloadOffset, err := alignUp(tagSize, maxPayloadAlign)
	if err != nil {
		return Layout{}, err
	}
	align := tagAlign
	if maxPayloadAlign > align {
		align = maxPayloadAlign
	}
	if payloadOffset > math.MaxUint64-maxPayloadSize {
		return Layout{}, fmt.Errorf("enum %s size overflow", symbol.ID.Name)
	}
	size, err := alignUp(payloadOffset+maxPayloadSize, align)
	if err != nil {
		return Layout{}, err
	}
	return Layout{
		ABI: FixedLayoutABI, Type: symbol.ID.Module + "." + symbol.ID.Name, Kind: "enum", Size: size, Align: align,
		TagSize: tagSize, PayloadOffset: payloadOffset, Variants: variants,
	}, nil
}

func fixedScalarLayoutKnown(name string) bool {
	_, _, ok := fixedScalarLayout(name)
	return ok
}

func fixedScalarLayout(name string) (uint64, uint64, bool) {
	switch name {
	case "bool", "i8", "u8":
		return 1, 1, true
	case "i16", "u16", "f16", "bf16":
		return 2, 2, true
	case "i32", "u32", "f32", "finite32":
		return 4, 4, true
	case "i64", "u64", "f64", "finite64", "ieee64", "number":
		return 8, 8, true
	case "i128", "u128":
		return 16, 16, true
	default:
		return 0, 0, false
	}
}

func alignUp(value, align uint64) (uint64, error) {
	if align == 0 || align&(align-1) != 0 {
		return 0, fmt.Errorf("invalid alignment %d", align)
	}
	mask := align - 1
	if value > math.MaxUint64-mask {
		return 0, fmt.Errorf("layout alignment overflow")
	}
	return (value + mask) &^ mask, nil
}

func checkedMul(a, b uint64) (uint64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	if a > math.MaxUint64/b {
		return 0, false
	}
	return a * b, true
}
