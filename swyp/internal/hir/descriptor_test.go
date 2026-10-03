package hir

import (
	"math"
	"strings"
	"testing"
)

func descriptorTestBundle() Bundle {
	return Bundle{Version: Version, Root: "types", Modules: []Module{{Version: Version, Name: "types"}}}
}

func TestDescriptorPlansSliceVecAndRefs(t *testing.T) {
	bundle := descriptorTestBundle()
	u64 := TypeRef{Name: "u64"}
	cases := []struct {
		typ       TypeRef
		kind      string
		ownership OwnershipClass
		size      uint64
		fields    int
	}{
		{TypeRef{Name: "slice", Args: []TypeRef{u64}}, "slice", OwnershipBorrowed, 24, 3},
		{TypeRef{Name: "vec", Args: []TypeRef{u64}}, "vec", OwnershipMove, 24, 3},
		{TypeRef{Name: "ref", Args: []TypeRef{u64}}, "ref", OwnershipBorrowed, 16, 2},
		{TypeRef{Name: "mutref", Args: []TypeRef{u64}}, "mutref", OwnershipBorrowed, 16, 2},
	}
	for _, tc := range cases {
		plan, err := PlanDescriptor(bundle, "types", tc.typ)
		if err != nil {
			t.Fatal(err)
		}
		if plan.ABI != DescriptorABI || plan.Kind != tc.kind || plan.Ownership != tc.ownership || plan.Size != tc.size || plan.Align != 8 || plan.ElementStride != 8 || len(plan.Fields) != tc.fields {
			t.Fatalf("plan %s=%+v", tc.typ.String(), plan)
		}
	}
}

func TestDescriptorRequiresFixedElementLayout(t *testing.T) {
	bundle := descriptorTestBundle()
	_, err := PlanDescriptor(bundle, "types", TypeRef{Name: "slice", Args: []TypeRef{{Name: "vec", Args: []TypeRef{{Name: "u64"}}}}})
	if err == nil || !strings.Contains(err.Error(), "undefined until ownership/descriptor ABI") {
		t.Fatalf("nested dynamic descriptor error=%v", err)
	}
}

func TestDescriptorBoundsAreOverflowSafe(t *testing.T) {
	bundle := descriptorTestBundle()
	plan, err := PlanDescriptor(bundle, "types", TypeRef{Name: "slice", Args: []TypeRef{{Name: "u64"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateDescriptor(plan, DescriptorValue{StorageID: 1, Offset: 3, Length: 4}, 7); err != nil {
		t.Fatal(err)
	}
	for _, value := range []DescriptorValue{
		{StorageID: 1, Offset: 4, Length: 4},
		{StorageID: 1, Offset: math.MaxUint64, Length: 2},
	} {
		if err := ValidateDescriptor(plan, value, 7); err == nil {
			t.Fatalf("accepted invalid slice descriptor %+v", value)
		}
	}
	if err := CheckDescriptorIndex(4, 3); err != nil {
		t.Fatal(err)
	}
	if err := CheckDescriptorIndex(4, 4); err == nil {
		t.Fatal("accepted out-of-bounds index")
	}
	if err := CheckDescriptorRange(4, 1, 4); err != nil {
		t.Fatal(err)
	}
	if err := CheckDescriptorRange(4, 3, 2); err == nil {
		t.Fatal("accepted reversed range")
	}
	if err := CheckDescriptorRange(4, 0, 5); err == nil {
		t.Fatal("accepted out-of-bounds range")
	}
}

func TestVecDescriptorEnforcesCapacity(t *testing.T) {
	plan, err := PlanDescriptor(descriptorTestBundle(), "types", TypeRef{Name: "vec", Args: []TypeRef{{Name: "u64"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateDescriptor(plan, DescriptorValue{StorageID: 1, Length: 3, Capacity: 4}, 4); err != nil {
		t.Fatal(err)
	}
	if err := ValidateDescriptor(plan, DescriptorValue{StorageID: 1, Length: 5, Capacity: 4}, 4); err == nil {
		t.Fatal("accepted vec length > capacity")
	}
	if err := ValidateDescriptor(plan, DescriptorValue{StorageID: 1, Length: 3, Capacity: 5}, 4); err == nil {
		t.Fatal("accepted vec capacity > backing elements")
	}
}
