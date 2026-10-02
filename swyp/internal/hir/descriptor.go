package hir

import (
	"fmt"
	"math"
)

// DescriptorABI is the compiler-owned logical descriptor contract for dynamic
// HIR views/owners. storage_id is an opaque allocation identity, never a raw
// native pointer or guest-authority token. Native lowering must resolve it
// through an explicit storage runtime.
const DescriptorABI = "swyp-descriptor-v1"

type DescriptorPlan struct {
	ABI           string            `json:"abi"`
	Type          string            `json:"type"`
	Kind          string            `json:"kind"`
	Ownership     OwnershipClass    `json:"ownership"`
	Size          uint64            `json:"size"`
	Align         uint64            `json:"align"`
	Element       string            `json:"element"`
	ElementSize   uint64            `json:"element_size"`
	ElementAlign  uint64            `json:"element_align"`
	ElementStride uint64            `json:"element_stride"`
	Fields        []DescriptorField `json:"fields"`
	Invariants    []string          `json:"invariants"`
}

type DescriptorField struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Offset   uint64 `json:"offset"`
	Semantic string `json:"semantic"`
}

type DescriptorValue struct {
	StorageID uint64 `json:"storage_id"`
	Offset    uint64 `json:"offset,omitempty"`
	Length    uint64 `json:"length,omitempty"`
	Capacity  uint64 `json:"capacity,omitempty"`
}

// PlanDescriptor defines representation only for descriptor types whose
// referent/element already has deterministic swyp-fixed-v1 layout.
func PlanDescriptor(bundle Bundle, currentModule string, typ TypeRef) (DescriptorPlan, error) {
	if err := bundle.Validate(); err != nil {
		return DescriptorPlan{}, fmt.Errorf("validate HIR bundle: %w", err)
	}
	if currentModule == "" {
		return DescriptorPlan{}, fmt.Errorf("descriptor planning requires current module")
	}
	if err := ValidateTypeRef(typ); err != nil {
		return DescriptorPlan{}, err
	}
	if len(typ.Args) != 1 || typ.Length != nil {
		return DescriptorPlan{}, fmt.Errorf("descriptor type must have exactly one type argument, got %s", typ.String())
	}
	switch typ.Name {
	case "slice", "vec", "ref", "mutref":
	default:
		return DescriptorPlan{}, fmt.Errorf("descriptor ABI does not cover %s", typ.String())
	}
	element, err := PlanFixedLayout(bundle, currentModule, typ.Args[0])
	if err != nil {
		return DescriptorPlan{}, fmt.Errorf("descriptor element %s: %w", typ.Args[0].String(), err)
	}
	stride, err := alignUp(element.Size, element.Align)
	if err != nil {
		return DescriptorPlan{}, err
	}
	ownership := OwnershipBorrowed
	fields := []DescriptorField{
		{Name: "storage_id", Type: "u64", Offset: 0, Semantic: "opaque_storage_identity"},
	}
	invariants := []string{
		"storage_id is opaque and never interpreted as a native pointer",
		"all offset/length arithmetic is checked before byte-address formation",
	}
	size := uint64(16)
	if typ.Name == "ref" || typ.Name == "mutref" {
		fields = append(fields, DescriptorField{Name: "offset", Type: "u64", Offset: 8, Semantic: "byte_offset"})
		invariants = append(invariants, "offset + element_size must be within backing storage")
	} else if typ.Name == "slice" {
		fields = append(fields,
			DescriptorField{Name: "offset", Type: "u64", Offset: 8, Semantic: "element_offset"},
			DescriptorField{Name: "length", Type: "u64", Offset: 16, Semantic: "element_length"},
		)
		size = 24
		invariants = append(invariants,
			"offset + length must not overflow",
			"offset + length must be within backing element count",
			"index access requires index < length",
			"range access requires start <= end <= length",
		)
	} else {
		ownership = OwnershipMove
		fields = append(fields,
			DescriptorField{Name: "length", Type: "u64", Offset: 8, Semantic: "element_length"},
			DescriptorField{Name: "capacity", Type: "u64", Offset: 16, Semantic: "element_capacity"},
		)
		size = 24
		invariants = append(invariants,
			"length <= capacity",
			"capacity * element_stride must not overflow",
			"index access requires index < length",
			"range access requires start <= end <= length",
		)
	}
	return DescriptorPlan{
		ABI: DescriptorABI, Type: typ.String(), Kind: typ.Name, Ownership: ownership,
		Size: size, Align: 8, Element: typ.Args[0].String(), ElementSize: element.Size,
		ElementAlign: element.Align, ElementStride: stride, Fields: fields, Invariants: invariants,
	}, nil
}

// ValidateDescriptor checks logical descriptor invariants against a known
// backing storage size/count. It does not dereference storage or acquire host
// authority.
func ValidateDescriptor(plan DescriptorPlan, value DescriptorValue, backingElements uint64) error {
	if plan.ABI != DescriptorABI {
		return fmt.Errorf("unsupported descriptor ABI %q", plan.ABI)
	}
	switch plan.Kind {
	case "ref", "mutref":
		backingBytes, ok := checkedMul(backingElements, plan.ElementStride)
		if !ok {
			return fmt.Errorf("backing byte size overflow")
		}
		if value.Offset > backingBytes || plan.ElementSize > backingBytes-value.Offset {
			return fmt.Errorf("reference offset out of backing storage bounds")
		}
		return nil
	case "slice":
		end, ok := checkedAdd(value.Offset, value.Length)
		if !ok || end > backingElements {
			return fmt.Errorf("slice offset/length outside backing storage")
		}
		return nil
	case "vec":
		if value.Length > value.Capacity {
			return fmt.Errorf("vec length %d exceeds capacity %d", value.Length, value.Capacity)
		}
		if value.Capacity > backingElements {
			return fmt.Errorf("vec capacity %d exceeds backing elements %d", value.Capacity, backingElements)
		}
		if _, ok := checkedMul(value.Capacity, plan.ElementStride); !ok {
			return fmt.Errorf("vec capacity byte size overflow")
		}
		return nil
	default:
		return fmt.Errorf("unknown descriptor kind %q", plan.Kind)
	}
}

func CheckDescriptorIndex(length, index uint64) error {
	if index >= length {
		return fmt.Errorf("index %d out of bounds for length %d", index, length)
	}
	return nil
}

func CheckDescriptorRange(length, start, end uint64) error {
	if start > end {
		return fmt.Errorf("range start %d exceeds end %d", start, end)
	}
	if end > length {
		return fmt.Errorf("range end %d out of bounds for length %d", end, length)
	}
	return nil
}

func DescriptorByteOffset(plan DescriptorPlan, elementOffset uint64) (uint64, error) {
	if plan.ElementStride == 0 {
		return 0, fmt.Errorf("descriptor element stride is zero")
	}
	value, ok := checkedMul(elementOffset, plan.ElementStride)
	if !ok {
		return 0, fmt.Errorf("descriptor byte offset overflow")
	}
	return value, nil
}

func checkedAdd(a, b uint64) (uint64, bool) {
	if a > math.MaxUint64-b {
		return 0, false
	}
	return a + b, true
}
