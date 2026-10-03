package storageabi

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

const (
	DefaultMaxBlocks = 1024
	DefaultMaxBytes  = 64 << 20
	StateVersion     = 1
)

// State is the deterministic, bounded representation of a Runtime. It exists so
// higher layers can checkpoint execution without reaching into Runtime internals.
// It carries no authority and must be validated with RestoreState before use.
type State struct {
	Version   uint64       `json:"version"`
	NextID    uint64       `json:"next_id"`
	MaxBlocks uint64       `json:"max_blocks"`
	MaxBytes  uint64       `json:"max_bytes"`
	Blocks    []StateBlock `json:"blocks"`
}

type StateBlock struct {
	ID             uint64 `json:"id"`
	ByteLen        uint64 `json:"byte_len"`
	LogicalByteLen uint64 `json:"logical_byte_len"`
	Align          uint64 `json:"align"`
	Mutable        bool   `json:"mutable"`
	Live           bool   `json:"live"`
	Data           []byte `json:"data,omitempty"`
}

// Runtime owns bounded opaque storage blocks. IDs are monotonic and never
// reused, so stale descriptors cannot become valid for later allocations.
// Runtime contains no language type semantics; HIR/Core layers add those.
type Runtime struct {
	mu        sync.RWMutex
	nextID    uint64
	blocks    map[uint64]*Block
	liveBytes uint64
	maxBlocks uint64
	maxBytes  uint64
}

type Block struct {
	ID             uint64 `json:"id"`
	ByteLen        uint64 `json:"byte_len"`
	LogicalByteLen uint64 `json:"logical_byte_len"`
	Align          uint64 `json:"align"`
	Mutable        bool   `json:"mutable"`
	Live           bool   `json:"live"`
	data           []byte
}

func New(maxBlocks, maxBytes uint64) (*Runtime, error) {
	if maxBlocks == 0 || maxBytes == 0 {
		return nil, fmt.Errorf("storage limits must be positive")
	}
	return &Runtime{nextID: 1, blocks: map[uint64]*Block{}, maxBlocks: maxBlocks, maxBytes: maxBytes}, nil
}

func NewDefault() *Runtime {
	r, err := New(DefaultMaxBlocks, DefaultMaxBytes)
	if err != nil {
		panic(err)
	}
	return r
}

func (r *Runtime) ExportState() (State, error) {
	if r == nil {
		return State{}, fmt.Errorf("storage runtime is nil")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]uint64, 0, len(r.blocks))
	for id := range r.blocks {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	state := State{Version: StateVersion, NextID: r.nextID, MaxBlocks: r.maxBlocks, MaxBytes: r.maxBytes, Blocks: make([]StateBlock, 0, len(ids))}
	for _, id := range ids {
		block := r.blocks[id]
		copy := StateBlock{ID: block.ID, ByteLen: block.ByteLen, LogicalByteLen: block.LogicalByteLen, Align: block.Align, Mutable: block.Mutable, Live: block.Live}
		if block.Live {
			copy.Data = append([]byte(nil), block.data...)
		}
		state.Blocks = append(state.Blocks, copy)
	}
	return state, nil
}

func RestoreState(state State) (*Runtime, error) {
	if state.Version != StateVersion || state.NextID == 0 || state.MaxBlocks == 0 || state.MaxBytes == 0 || uint64(len(state.Blocks)) > state.MaxBlocks {
		return nil, fmt.Errorf("invalid storage checkpoint header")
	}
	r := &Runtime{nextID: state.NextID, blocks: make(map[uint64]*Block, len(state.Blocks)), maxBlocks: state.MaxBlocks, maxBytes: state.MaxBytes}
	var previous, liveBytes uint64
	for _, encoded := range state.Blocks {
		if encoded.ID == 0 || encoded.ID <= previous || encoded.ID >= state.NextID || encoded.Align == 0 || encoded.Align&(encoded.Align-1) != 0 ||
			encoded.LogicalByteLen > encoded.ByteLen || encoded.ByteLen > uint64(int(^uint(0)>>1)) {
			return nil, fmt.Errorf("invalid storage checkpoint block %d", encoded.ID)
		}
		previous = encoded.ID
		if encoded.Live {
			if uint64(len(encoded.Data)) != encoded.ByteLen || encoded.ByteLen > state.MaxBytes-liveBytes {
				return nil, fmt.Errorf("invalid live storage checkpoint block %d", encoded.ID)
			}
			liveBytes += encoded.ByteLen
		} else if len(encoded.Data) != 0 {
			return nil, fmt.Errorf("freed storage checkpoint block %d carries data", encoded.ID)
		}
		r.blocks[encoded.ID] = &Block{
			ID: encoded.ID, ByteLen: encoded.ByteLen, LogicalByteLen: encoded.LogicalByteLen,
			Align: encoded.Align, Mutable: encoded.Mutable, Live: encoded.Live, data: append([]byte(nil), encoded.Data...),
		}
	}
	r.liveBytes = liveBytes
	return r, nil
}

func (r *Runtime) Allocate(byteLen, align uint64, mutable bool) (uint64, error) {
	if r == nil {
		return 0, fmt.Errorf("storage runtime is nil")
	}
	if align == 0 || align&(align-1) != 0 {
		return 0, fmt.Errorf("storage alignment %d is not a power of two", align)
	}
	if byteLen > uint64(int(^uint(0)>>1)) {
		return 0, fmt.Errorf("storage allocation %d exceeds host addressable size", byteLen)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if uint64(len(r.blocks)) >= r.maxBlocks {
		return 0, fmt.Errorf("storage block limit %d exceeded", r.maxBlocks)
	}
	if byteLen > r.maxBytes-r.liveBytes {
		return 0, fmt.Errorf("storage byte limit %d exceeded", r.maxBytes)
	}
	if r.nextID == 0 || r.nextID == math.MaxUint64 {
		return 0, fmt.Errorf("storage ID space exhausted")
	}
	id := r.nextID
	r.nextID++
	r.blocks[id] = &Block{ID: id, ByteLen: byteLen, LogicalByteLen: byteLen, Align: align, Mutable: mutable, Live: true, data: make([]byte, int(byteLen))}
	r.liveBytes += byteLen
	return id, nil
}

func (r *Runtime) SetLogicalByteLen(id, logical uint64) error {
	if r == nil {
		return fmt.Errorf("storage runtime is nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	block, err := liveBlock(r.blocks, id)
	if err != nil {
		return err
	}
	if logical > block.ByteLen {
		return fmt.Errorf("storage logical length %d exceeds capacity %d", logical, block.ByteLen)
	}
	block.LogicalByteLen = logical
	return nil
}

func (r *Runtime) Free(id uint64) error {
	if r == nil {
		return fmt.Errorf("storage runtime is nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	block, err := liveBlock(r.blocks, id)
	if err != nil {
		return err
	}
	block.Live = false
	r.liveBytes -= block.ByteLen
	block.data = nil
	return nil
}

func (r *Runtime) Snapshot(id uint64) (Block, error) {
	if r == nil {
		return Block{}, fmt.Errorf("storage runtime is nil")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	block, ok := r.blocks[id]
	if !ok {
		return Block{}, fmt.Errorf("unknown storage %d", id)
	}
	copyBlock := *block
	copyBlock.data = nil
	return copyBlock, nil
}

func (r *Runtime) Read(id, offset, size uint64) ([]byte, error) {
	if r == nil {
		return nil, fmt.Errorf("storage runtime is nil")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	block, err := liveBlock(r.blocks, id)
	if err != nil {
		return nil, err
	}
	end, ok := checkedAdd(offset, size)
	if !ok || end > block.ByteLen {
		return nil, fmt.Errorf("storage read [%d:%d] outside %d-byte block", offset, end, block.ByteLen)
	}
	return append([]byte(nil), block.data[int(offset):int(end)]...), nil
}

func (r *Runtime) Write(id, offset uint64, data []byte) error {
	if r == nil {
		return fmt.Errorf("storage runtime is nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	block, err := liveBlock(r.blocks, id)
	if err != nil {
		return err
	}
	if !block.Mutable {
		return fmt.Errorf("storage %d is immutable", id)
	}
	end, ok := checkedAdd(offset, uint64(len(data)))
	if !ok || end > block.ByteLen {
		return fmt.Errorf("storage write [%d:%d] outside %d-byte block", offset, end, block.ByteLen)
	}
	copy(block.data[int(offset):int(end)], data)
	return nil
}

func liveBlock(blocks map[uint64]*Block, id uint64) (*Block, error) {
	if id == 0 {
		return nil, fmt.Errorf("storage ID 0 is invalid")
	}
	block, ok := blocks[id]
	if !ok || !block.Live {
		return nil, fmt.Errorf("storage %d is not live", id)
	}
	return block, nil
}

func checkedAdd(a, b uint64) (uint64, bool) {
	if a > math.MaxUint64-b {
		return 0, false
	}
	return a + b, true
}
