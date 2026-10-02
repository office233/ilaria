package hir

import (
	"bytes"
	"testing"
)

func TestStorageRuntimeMonotonicIDsAndNoStaleReuse(t *testing.T) {
	runtime, err := NewStorageRuntime(4, 1024)
	if err != nil {
		t.Fatal(err)
	}
	first, err := runtime.Allocate(16, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Free(first); err != nil {
		t.Fatal(err)
	}
	second, err := runtime.Allocate(16, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	if first == 0 || second <= first {
		t.Fatalf("IDs first=%d second=%d", first, second)
	}
	if _, err := runtime.Read(first, 0, 1); err == nil {
		t.Fatal("stale freed storage ID became readable")
	}
}

func TestStorageRuntimeReadWriteBoundsAndMutability(t *testing.T) {
	runtime := NewDefaultStorageRuntime()
	id, err := runtime.Allocate(8, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Write(id, 2, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	got, err := runtime.Read(id, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte{1, 2, 3}) {
		t.Fatalf("read=%v", got)
	}
	if err := runtime.Write(id, 7, []byte{1, 2}); err == nil {
		t.Fatal("out-of-bounds write accepted")
	}
	immutable, err := runtime.Allocate(8, 8, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Write(immutable, 0, []byte{1}); err == nil {
		t.Fatal("immutable storage write accepted")
	}
}

func TestStorageRuntimeValidatesDescriptorAgainstLiveBacking(t *testing.T) {
	plan, err := PlanDescriptor(descriptorTestBundle(), "types", TypeRef{Name: "slice", Args: []TypeRef{{Name: "u64"}}})
	if err != nil {
		t.Fatal(err)
	}
	runtime := NewDefaultStorageRuntime()
	id, err := runtime.Allocate(32, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	valid := DescriptorValue{StorageID: id, Offset: 1, Length: 3}
	if err := runtime.ValidateDescriptor(plan, valid); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ValidateDescriptor(plan, DescriptorValue{StorageID: id, Offset: 2, Length: 3}); err == nil {
		t.Fatal("descriptor beyond backing storage accepted")
	}
	if err := runtime.Free(id); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ValidateDescriptor(plan, valid); err == nil {
		t.Fatal("descriptor to freed storage accepted")
	}
}

func TestStorageRuntimeResourceLimits(t *testing.T) {
	runtime, err := NewStorageRuntime(1, 8)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Allocate(9, 1, true); err == nil {
		t.Fatal("byte limit not enforced")
	}
	if _, err := runtime.Allocate(8, 1, true); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Allocate(0, 1, true); err == nil {
		t.Fatal("block limit not enforced")
	}
}
