package hir

import (
	"fmt"

	"swyp-lang/internal/storageabi"
)

const (
	DefaultStorageMaxBlocks = storageabi.DefaultMaxBlocks
	DefaultStorageMaxBytes  = storageabi.DefaultMaxBytes
)

// StorageRuntime is the reference implementation of swyp-descriptor-v1 backing
// storage semantics. It is an oracle for compiler/runtime differential tests,
// not a second Swyp execution engine. storage IDs are monotonic and never reused,
// preventing stale descriptors from becoming valid for a later allocation.
type StorageRuntime struct{ *storageabi.Runtime }
type StorageBlock = storageabi.Block

func NewStorageRuntime(maxBlocks, maxBytes uint64) (*StorageRuntime, error) {
	r, err := storageabi.New(maxBlocks, maxBytes)
	if err != nil {
		return nil, err
	}
	return &StorageRuntime{Runtime: r}, nil
}

func NewDefaultStorageRuntime() *StorageRuntime {
	return &StorageRuntime{Runtime: storageabi.NewDefault()}
}

func (r *StorageRuntime) ValidateDescriptor(plan DescriptorPlan, value DescriptorValue) error {
	if r == nil {
		return fmt.Errorf("storage runtime is nil")
	}
	if r == nil || r.Runtime == nil {
		return fmt.Errorf("storage runtime is nil")
	}
	block, err := r.Snapshot(value.StorageID)
	if err != nil {
		return err
	}
	if !block.Live {
		return fmt.Errorf("storage %d is not live", value.StorageID)
	}
	if plan.ElementStride == 0 {
		return fmt.Errorf("descriptor element stride is zero")
	}
	if block.ByteLen%plan.ElementStride != 0 {
		return fmt.Errorf("storage %d size %d is not a multiple of element stride %d", block.ID, block.ByteLen, plan.ElementStride)
	}
	return ValidateDescriptor(plan, value, block.ByteLen/plan.ElementStride)
}
