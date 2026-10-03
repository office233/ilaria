package storageabi

import (
	"bytes"
	"testing"
)

func TestLogicalLengthIsBoundedAndRequiresLiveBlock(t *testing.T) {
	r, err := New(4, 1024)
	if err != nil {
		t.Fatal(err)
	}
	id, err := r.Allocate(32, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	b, err := r.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	if b.ByteLen != 32 || b.LogicalByteLen != 32 {
		t.Fatalf("block=%+v", b)
	}
	if err := r.SetLogicalByteLen(id, 16); err != nil {
		t.Fatal(err)
	}
	b, _ = r.Snapshot(id)
	if b.LogicalByteLen != 16 {
		t.Fatalf("logical=%d", b.LogicalByteLen)
	}
	if err := r.SetLogicalByteLen(id, 40); err == nil {
		t.Fatal("logical length beyond capacity accepted")
	}
	if err := r.Free(id); err != nil {
		t.Fatal(err)
	}
	if err := r.SetLogicalByteLen(id, 0); err == nil {
		t.Fatal("logical length update after free accepted")
	}
}

func TestRuntimeStateRoundTripPreservesIDsDataAndFreedBlocks(t *testing.T) {
	r, err := New(8, 1024)
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.Allocate(16, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Allocate(24, 8, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Write(first, 4, []byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if err := r.SetLogicalByteLen(first, 12); err != nil {
		t.Fatal(err)
	}
	if err := r.Free(second); err != nil {
		t.Fatal(err)
	}
	state, err := r.ExportState()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreState(state)
	if err != nil {
		t.Fatal(err)
	}
	data, err := restored.Read(first, 0, 16)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]byte, 16)
	copy(want[4:], []byte{1, 2, 3, 4})
	if !bytes.Equal(data, want) {
		t.Fatalf("restored data=%v want=%v", data, want)
	}
	block, err := restored.Snapshot(first)
	if err != nil || block.LogicalByteLen != 12 {
		t.Fatalf("restored first block=%+v err=%v", block, err)
	}
	freed, err := restored.Snapshot(second)
	if err != nil || freed.Live {
		t.Fatalf("freed block was not preserved: %+v err=%v", freed, err)
	}
	third, err := restored.Allocate(8, 8, true)
	if err != nil || third != 3 {
		t.Fatalf("monotonic ID after restore=%d err=%v", third, err)
	}
}

func TestRestoreStateRejectsTampering(t *testing.T) {
	valid := State{Version: StateVersion, NextID: 2, MaxBlocks: 4, MaxBytes: 64, Blocks: []StateBlock{{
		ID: 1, ByteLen: 8, LogicalByteLen: 8, Align: 8, Mutable: true, Live: true, Data: make([]byte, 8),
	}}}
	mutations := map[string]func(*State){
		"version":       func(s *State) { s.Version++ },
		"next-id":       func(s *State) { s.NextID = 1 },
		"duplicate-id":  func(s *State) { s.Blocks = append(s.Blocks, s.Blocks[0]) },
		"bad-alignment": func(s *State) { s.Blocks[0].Align = 3 },
		"bad-data":      func(s *State) { s.Blocks[0].Data = nil },
		"over-budget":   func(s *State) { s.MaxBytes = 4 },
		"freed-data":    func(s *State) { s.Blocks[0].Live = false },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			state := valid
			state.Blocks = append([]StateBlock(nil), valid.Blocks...)
			state.Blocks[0].Data = append([]byte(nil), valid.Blocks[0].Data...)
			mutate(&state)
			if _, err := RestoreState(state); err == nil {
				t.Fatal("tampered storage state accepted")
			}
		})
	}
}
