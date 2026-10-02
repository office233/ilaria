// Package hircore lowers linked Swyp HIR bundles into the existing validated
// Core IR. It is intentionally a translation layer, not a second runtime.
package hircore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hir"
)

const maxScalarizedDynamicArrayLength = 64

type Result struct {
	Module  coreir.Module
	Entry   string
	Symbols map[string]string // HIR canonical symbol -> Core IR function name.
}

func Lower(bundle hir.Bundle, entry string) (Result, error) {
	if err := bundle.Validate(); err != nil {
		return Result{}, fmt.Errorf("validate HIR bundle: %w", err)
	}
	ownership, err := hir.AnalyzeOwnership(bundle)
	if err != nil {
		return Result{}, fmt.Errorf("analyze HIR ownership: %w", err)
	}
	if ownership.Status != "ok" {
		if len(ownership.Diagnostics) == 0 {
			return Result{}, fmt.Errorf("HIR ownership gate failed")
		}
		diagnostic := ownership.Diagnostics[0]
		return Result{}, fmt.Errorf("HIR ownership gate %s: %s", diagnostic.Code, diagnostic.Message)
	}
	if entry == "" {
		return Result{}, fmt.Errorf("HIR Core lowering requires root entry function")
	}
	functions := map[string]hir.Declaration{}
	for _, module := range bundle.Modules {
		for _, decl := range module.Declarations {
			if decl.Function != nil {
				functions[decl.ID.Canonical()] = decl
			}
		}
	}
	rootID := hir.SymbolID{Module: bundle.Root, Kind: "fn", Name: entry}
	rootKey := rootID.Canonical()
	if _, ok := functions[rootKey]; !ok {
		return Result{}, fmt.Errorf("root entry %s not found", rootKey)
	}
	selected := map[string]bool{}
	var visit func(string) error
	visit = func(key string) error {
		if selected[key] {
			return nil
		}
		decl, ok := functions[key]
		if !ok || decl.Function == nil {
			return fmt.Errorf("unknown HIR function %s", key)
		}
		if len(selected) >= coreir.MaxFunctions {
			return fmt.Errorf("reachable HIR function count exceeds Core limit %d", coreir.MaxFunctions)
		}
		selected[key] = true
		for _, callee := range bodyCallees(decl.Function.Body) {
			if err := visit(callee.Canonical()); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(rootKey); err != nil {
		return Result{}, err
	}

	keys := make([]string, 0, len(selected))
	for key := range selected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	symbols, err := coreSymbolNames(keys, rootKey, entry)
	if err != nil {
		return Result{}, err
	}
	types, err := hir.BuildTypeTable(bundle.Modules)
	if err != nil {
		return Result{}, fmt.Errorf("build HIR type table: %w", err)
	}

	arena := byteArena{offsets: map[string]uint32{}}
	module := coreir.Module{Version: coreir.Version}
	for _, key := range keys {
		decl := functions[key]
		lowered, err := lowerFunction(decl, symbols, functions, &arena, types)
		if err != nil {
			return Result{}, fmt.Errorf("lower %s: %w", key, err)
		}
		module.Functions = append(module.Functions, lowered)
	}
	module.Data = append([]byte(nil), arena.data...)
	propagateEffects(&module)
	if err := module.Validate(); err != nil {
		return Result{}, fmt.Errorf("validate lowered Core IR: %w", err)
	}
	return Result{Module: module, Entry: symbols[rootKey], Symbols: symbols}, nil
}

func bodyCallees(body []hir.Statement) []hir.SymbolID {
	seen := map[string]hir.SymbolID{}
	var expr func(hir.Expression)
	expr = func(e hir.Expression) {
		if e.Callee != nil {
			seen[e.Callee.Canonical()] = *e.Callee
		}
		for _, arg := range e.Args {
			expr(arg)
		}
		for _, field := range e.Fields {
			expr(field.Value)
		}
		for _, arm := range e.Arms {
			expr(arm.Value)
		}
	}
	var walk func([]hir.Statement)
	walk = func(body []hir.Statement) {
		for _, stmt := range body {
			if stmt.Value != nil {
				expr(*stmt.Value)
			}
			walk(stmt.Body)
			walk(stmt.Else)
		}
	}
	walk(body)
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]hir.SymbolID, 0, len(keys))
	for _, key := range keys {
		out = append(out, seen[key])
	}
	return out
}

func coreSymbolNames(keys []string, rootKey, entry string) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	used := map[string]string{}
	for _, key := range keys {
		name := ""
		if key == rootKey {
			name = entry
		} else {
			hash := sha256.Sum256([]byte(key))
			name = "swyp_hir_" + hex.EncodeToString(hash[:])
		}
		if previous, exists := used[name]; exists && previous != key {
			if key == rootKey {
				return nil, fmt.Errorf("root entry name %q collides with linked symbol %s", entry, previous)
			}
			name = "swyp_hir2_" + strings.TrimPrefix(name, "swyp_hir_")
			if previous, exists := used[name]; exists && previous != key {
				return nil, fmt.Errorf("Core symbol hash collision between %s and %s", previous, key)
			}
		}
		used[name], out[key] = key, name
	}
	return out, nil
}

func coreType(t hir.TypeRef) (coreir.Type, error) {
	if len(t.Args) != 0 || t.Length != nil {
		return "", fmt.Errorf("Core lowering does not support compound type %s", t.Name)
	}
	switch t.Name {
	case "i64":
		return coreir.I64, nil
	case "u64":
		return coreir.U64, nil
	case "f64", "number":
		return coreir.F64, nil
	case "ieee64":
		return coreir.IEEE64, nil
	case "bool":
		return coreir.Bool, nil
	case "bytes":
		return coreir.Bytes, nil
	case "void":
		return coreir.Void, nil
	default:
		return "", fmt.Errorf("Core lowering does not support type %s", t.Name)
	}
}

type byteArena struct {
	data    []byte
	offsets map[string]uint32
}

func (a *byteArena) intern(text string) (coreir.Literal, error) {
	if offset, ok := a.offsets[text]; ok {
		value, err := coreir.ByteSpan(offset, uint32(len(text)))
		if err != nil {
			return coreir.Literal{}, err
		}
		return value.Literal(), nil
	}
	if len(a.data)+len(text) > coreir.MaxByteArenaBytes {
		return coreir.Literal{}, fmt.Errorf("Core byte arena exceeds %d bytes", coreir.MaxByteArenaBytes)
	}
	offset := uint32(len(a.data))
	a.data = append(a.data, []byte(text)...)
	a.offsets[text] = offset
	value, err := coreir.ByteSpan(offset, uint32(len(text)))
	if err != nil {
		return coreir.Literal{}, err
	}
	return value.Literal(), nil
}

type scope struct {
	slots            map[string]int
	fixedArrays      map[string]fixedArrayLocal
	storageArrays    map[string]storageArrayLocal
	storageVecs      map[string]storageVecLocal
	storageRefs      map[string]storageRefLocal
	fixedSlices      map[string]fixedSliceLocal
	storageSlices    map[string]storageSliceLocal
	fixedStructs     map[string]fixedStructLocal
	fixedSums        map[string]fixedSumLocal
	fixedRefs        map[string]fixedRefLocal
	deferredVecDrops []string
	parent           *scope
}

type fixedArrayLocal struct {
	typ   hir.TypeRef
	slots []int
}

type storageArrayLocal struct {
	typ    hir.TypeRef
	idSlot int
	length uint64
}

type storageVecLocal struct {
	typ          hir.TypeRef
	idSlot       int
	lengthSlot   int
	capacitySlot int
}

type storageRefLocal struct {
	typ       hir.TypeRef
	idSlot    int
	indexSlot int
	mutable   bool
}

type storageSliceLocal struct {
	typ       hir.TypeRef
	idSlot    int
	startSlot int
	endSlot   int
}

type fixedSliceLocal struct {
	typ       hir.TypeRef
	slots     []int
	dynamic   bool
	startSlot int
	endSlot   int
}

type fixedStructLocal struct {
	typ    hir.TypeRef
	fields map[string]int
}

type fixedSumLocal struct {
	typ         hir.TypeRef
	variant     string
	payloadSlot int
	payloadType *hir.TypeRef
}

type fixedRefLocal struct {
	typ        hir.TypeRef
	targetSlot int
	mutable    bool
}

func (s *scope) lookup(name string) (int, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if slot, ok := cur.slots[name]; ok {
			return slot, true
		}
		if _, shadowsScalar := cur.fixedArrays[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.storageArrays[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.storageVecs[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.storageRefs[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.fixedSlices[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.storageSlices[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.fixedStructs[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.fixedSums[name]; shadowsScalar {
			return -1, false
		}
		if _, shadowsScalar := cur.fixedRefs[name]; shadowsScalar {
			return -1, false
		}
	}
	return -1, false
}

func (s *scope) lookupStorageVec(name string) (storageVecLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.storageVecs[name]; ok {
			return value, true
		}
		if _, shadows := cur.slots[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.fixedArrays[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.storageArrays[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.storageRefs[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.fixedSlices[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.storageSlices[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.fixedStructs[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.fixedSums[name]; shadows {
			return storageVecLocal{}, false
		}
		if _, shadows := cur.fixedRefs[name]; shadows {
			return storageVecLocal{}, false
		}
	}
	return storageVecLocal{}, false
}

func (s *scope) lookupStorageRef(name string) (storageRefLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.storageRefs[name]; ok {
			return value, true
		}
		if _, shadows := cur.slots[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.fixedArrays[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.storageArrays[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.storageVecs[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.fixedSlices[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.storageSlices[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.fixedStructs[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.fixedSums[name]; shadows {
			return storageRefLocal{}, false
		}
		if _, shadows := cur.fixedRefs[name]; shadows {
			return storageRefLocal{}, false
		}
	}
	return storageRefLocal{}, false
}

func (s *scope) lookupStorageSlice(name string) (storageSliceLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.storageSlices[name]; ok {
			return value, true
		}
		if _, shadows := cur.slots[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.fixedArrays[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.storageArrays[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.fixedSlices[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.fixedStructs[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.fixedSums[name]; shadows {
			return storageSliceLocal{}, false
		}
		if _, shadows := cur.fixedRefs[name]; shadows {
			return storageSliceLocal{}, false
		}
	}
	return storageSliceLocal{}, false
}

func (s *scope) lookupStorageArray(name string) (storageArrayLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.storageArrays[name]; ok {
			return value, true
		}
		if _, shadows := cur.slots[name]; shadows {
			return storageArrayLocal{}, false
		}
		if _, shadows := cur.fixedArrays[name]; shadows {
			return storageArrayLocal{}, false
		}
		if _, shadows := cur.fixedSlices[name]; shadows {
			return storageArrayLocal{}, false
		}
		if _, shadows := cur.fixedStructs[name]; shadows {
			return storageArrayLocal{}, false
		}
		if _, shadows := cur.fixedSums[name]; shadows {
			return storageArrayLocal{}, false
		}
		if _, shadows := cur.fixedRefs[name]; shadows {
			return storageArrayLocal{}, false
		}
	}
	return storageArrayLocal{}, false
}

func (s *scope) lookupFixedSlice(name string) (fixedSliceLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.fixedSlices[name]; ok {
			return value, true
		}
		if _, shadows := cur.slots[name]; shadows {
			return fixedSliceLocal{}, false
		}
		if _, shadows := cur.fixedArrays[name]; shadows {
			return fixedSliceLocal{}, false
		}
		if _, shadows := cur.fixedStructs[name]; shadows {
			return fixedSliceLocal{}, false
		}
		if _, shadows := cur.fixedSums[name]; shadows {
			return fixedSliceLocal{}, false
		}
		if _, shadows := cur.fixedRefs[name]; shadows {
			return fixedSliceLocal{}, false
		}
	}
	return fixedSliceLocal{}, false
}

func (s *scope) lookupFixedArray(name string) (fixedArrayLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.fixedArrays[name]; ok {
			return value, true
		}
		if _, shadowsArray := cur.slots[name]; shadowsArray {
			return fixedArrayLocal{}, false
		}
		if _, shadowsArray := cur.fixedStructs[name]; shadowsArray {
			return fixedArrayLocal{}, false
		}
		if _, shadowsArray := cur.fixedSums[name]; shadowsArray {
			return fixedArrayLocal{}, false
		}
		if _, shadowsArray := cur.fixedRefs[name]; shadowsArray {
			return fixedArrayLocal{}, false
		}
	}
	return fixedArrayLocal{}, false
}

func (s *scope) lookupFixedStruct(name string) (fixedStructLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.fixedStructs[name]; ok {
			return value, true
		}
		if _, shadowsStruct := cur.slots[name]; shadowsStruct {
			return fixedStructLocal{}, false
		}
		if _, shadowsStruct := cur.fixedArrays[name]; shadowsStruct {
			return fixedStructLocal{}, false
		}
		if _, shadowsStruct := cur.fixedSums[name]; shadowsStruct {
			return fixedStructLocal{}, false
		}
		if _, shadowsStruct := cur.fixedRefs[name]; shadowsStruct {
			return fixedStructLocal{}, false
		}
	}
	return fixedStructLocal{}, false
}

func (s *scope) lookupFixedSum(name string) (fixedSumLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.fixedSums[name]; ok {
			return value, true
		}
		if _, shadowsSum := cur.slots[name]; shadowsSum {
			return fixedSumLocal{}, false
		}
		if _, shadowsSum := cur.fixedArrays[name]; shadowsSum {
			return fixedSumLocal{}, false
		}
		if _, shadowsSum := cur.fixedStructs[name]; shadowsSum {
			return fixedSumLocal{}, false
		}
		if _, shadowsSum := cur.fixedRefs[name]; shadowsSum {
			return fixedSumLocal{}, false
		}
	}
	return fixedSumLocal{}, false
}

func (s *scope) lookupFixedRef(name string) (fixedRefLocal, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.fixedRefs[name]; ok {
			return value, true
		}
		if _, shadowsRef := cur.slots[name]; shadowsRef {
			return fixedRefLocal{}, false
		}
		if _, shadowsRef := cur.fixedArrays[name]; shadowsRef {
			return fixedRefLocal{}, false
		}
		if _, shadowsRef := cur.fixedStructs[name]; shadowsRef {
			return fixedRefLocal{}, false
		}
		if _, shadowsRef := cur.fixedSums[name]; shadowsRef {
			return fixedRefLocal{}, false
		}
	}
	return fixedRefLocal{}, false
}

type builder struct {
	f            coreir.Function
	symbols      map[string]string
	functions    map[string]hir.Declaration
	arena        *byteArena
	types        hir.TypeTable
	module       string
	hirResult    hir.TypeRef
	vecResult    bool
	current      int
	instructions int
}

func lowerFunction(decl hir.Declaration, symbols map[string]string, functions map[string]hir.Declaration, arena *byteArena, types hir.TypeTable) (coreir.Function, error) {
	if decl.Function == nil {
		return coreir.Function{}, fmt.Errorf("function declaration missing signature")
	}
	vecResult := storageVecType(types, decl.ID.Module, decl.Function.Result)
	result := coreir.U64
	var err error
	if !vecResult {
		result, err = coreType(decl.Function.Result)
		if err != nil {
			return coreir.Function{}, err
		}
	}
	b := builder{f: coreir.Function{Name: symbols[decl.ID.Canonical()], Result: result}, symbols: symbols, functions: functions, arena: arena, types: types, module: decl.ID.Module, hirResult: decl.Function.Result, vecResult: vecResult}
	env := &scope{slots: map[string]int{}, fixedArrays: map[string]fixedArrayLocal{}, storageArrays: map[string]storageArrayLocal{}, storageVecs: map[string]storageVecLocal{}, storageRefs: map[string]storageRefLocal{}, fixedSlices: map[string]fixedSliceLocal{}, storageSlices: map[string]storageSliceLocal{}, fixedStructs: map[string]fixedStructLocal{}, fixedSums: map[string]fixedSumLocal{}, fixedRefs: map[string]fixedRefLocal{}}
	for _, param := range decl.Function.Params {
		if storageVecType(types, decl.ID.Module, param.Type) {
			idSlot, err := b.slot(coreir.U64)
			if err != nil {
				return coreir.Function{}, err
			}
			lengthSlot, err := b.slot(coreir.U64)
			if err != nil {
				return coreir.Function{}, err
			}
			capacitySlot, err := b.slot(coreir.U64)
			if err != nil {
				return coreir.Function{}, err
			}
			b.f.Params = append(b.f.Params,
				coreir.Parameter{Name: param.Name + "__storage_id", Type: coreir.U64},
				coreir.Parameter{Name: param.Name + "__length", Type: coreir.U64},
				coreir.Parameter{Name: param.Name + "__capacity", Type: coreir.U64},
			)
			env.storageVecs[param.Name] = storageVecLocal{typ: param.Type, idSlot: idSlot, lengthSlot: lengthSlot, capacitySlot: capacitySlot}
			continue
		}
		t, err := coreType(param.Type)
		if err != nil {
			return coreir.Function{}, fmt.Errorf("parameter %s: %w", param.Name, err)
		}
		slot, err := b.slot(t)
		if err != nil {
			return coreir.Function{}, err
		}
		b.f.Params = append(b.f.Params, coreir.Parameter{Name: param.Name, Type: t})
		env.slots[param.Name] = slot
	}
	if _, err := b.newBlock(); err != nil {
		return coreir.Function{}, err
	}
	if err := b.block(decl.Function.Body, env); err != nil {
		return coreir.Function{}, err
	}
	if !b.closed() {
		op := "return"
		if b.f.Result != coreir.Void {
			op = "unreachable"
		}
		b.terminate(coreir.Terminator{Op: op, Value: -1})
	}
	canonicalizeEffects(&b.f)
	return b.f, nil
}

func (b *builder) slot(t coreir.Type) (int, error) {
	if t == coreir.Void {
		return -1, fmt.Errorf("void cannot occupy a Core slot")
	}
	if len(b.f.Slots) >= coreir.MaxSlots {
		return -1, fmt.Errorf("Core slot limit exceeded")
	}
	slot := len(b.f.Slots)
	b.f.Slots = append(b.f.Slots, t)
	return slot, nil
}

func (b *builder) newBlock() (int, error) {
	if len(b.f.Blocks) >= coreir.MaxBlocks {
		return -1, fmt.Errorf("Core block limit exceeded")
	}
	index := len(b.f.Blocks)
	b.f.Blocks = append(b.f.Blocks, coreir.Block{})
	b.current = index
	return index, nil
}

func (b *builder) emit(ins coreir.Instruction) error {
	b.instructions++
	if b.instructions > coreir.MaxInstructions {
		return fmt.Errorf("Core instruction limit exceeded")
	}
	b.f.Blocks[b.current].Instructions = append(b.f.Blocks[b.current].Instructions, ins)
	return nil
}

func (b *builder) terminate(term coreir.Terminator) { b.f.Blocks[b.current].Terminator = term }
func (b *builder) closed() bool                     { return b.f.Blocks[b.current].Terminator.Op != "" }

func (b *builder) jump(target int, loc hir.Location) {
	b.terminate(coreir.Terminator{Op: "jump", Value: -1, Targets: []int{target}, Location: coreLocation(loc)})
}

func (b *builder) block(body []hir.Statement, parent *scope) error {
	env := &scope{slots: map[string]int{}, fixedArrays: map[string]fixedArrayLocal{}, storageArrays: map[string]storageArrayLocal{}, storageVecs: map[string]storageVecLocal{}, storageRefs: map[string]storageRefLocal{}, fixedSlices: map[string]fixedSliceLocal{}, storageSlices: map[string]storageSliceLocal{}, fixedStructs: map[string]fixedStructLocal{}, fixedSums: map[string]fixedSumLocal{}, fixedRefs: map[string]fixedRefLocal{}, parent: parent}
	for _, stmt := range body {
		if b.closed() {
			if _, err := b.newBlock(); err != nil {
				return err
			}
		}
		switch stmt.Kind {
		case "let":
			if stmt.Type != nil && storageVecType(b.types, b.module, *stmt.Type) && stmt.Value != nil && stmt.Value.Kind == "call" && stmt.Value.Callee != nil {
				if err := b.storageVecCallLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Type.Name == "vec" && stmt.Value != nil && stmt.Value.Kind == "vec" {
				if err := b.storageVecLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Type.Name == "slice" && stmt.Value != nil && stmt.Value.Kind == "slice" {
				if err := b.fixedSliceLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Type.Name == "array" {
				if err := b.fixedArrayLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if b.storageVecStructCopySupported(stmt, env) {
				if err := b.storageVecStructCopyLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if b.storageSliceStructCopySupported(stmt, env) {
				if err := b.storageSliceStructCopyLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Value != nil && stmt.Value.Kind == "struct" {
				if err := b.fixedStructLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Value != nil && stmt.Value.Kind == "enum" {
				if err := b.fixedSumLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			if stmt.Type != nil && stmt.Value != nil && (stmt.Type.Name == "ref" || stmt.Type.Name == "mutref") && stmt.Value.Kind == "borrow" {
				if b.storageRefPlaceSupported(*stmt.Value, env) {
					if err := b.storageRefLet(stmt, env); err != nil {
						return err
					}
					continue
				}
				if err := b.fixedRefLet(stmt, env); err != nil {
					return err
				}
				continue
			}
			value, err := b.expression(*stmt.Value, env)
			if err != nil {
				return err
			}
			t, err := coreType(*stmt.Type)
			if err != nil {
				return err
			}
			dest, err := b.slot(t)
			if err != nil {
				return err
			}
			if err := b.move(dest, value, stmt.Location); err != nil {
				return err
			}
			env.slots[stmt.Name] = dest
		case "assign":
			if _, ok := env.lookupStorageVec(stmt.Name); ok {
				return fmt.Errorf("storage-vec Core lowering does not support whole-vec assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupStorageSlice(stmt.Name); ok {
				return fmt.Errorf("storage-slice Core lowering does not support whole-slice assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupStorageArray(stmt.Name); ok {
				return fmt.Errorf("storage-array Core lowering does not support whole-array assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupFixedSlice(stmt.Name); ok {
				return fmt.Errorf("fixed-slice Core lowering does not support whole-slice assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupFixedArray(stmt.Name); ok {
				return fmt.Errorf("fixed-array Core lowering does not support whole-array assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupFixedStruct(stmt.Name); ok {
				return fmt.Errorf("fixed-struct Core lowering does not support whole-struct assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupFixedSum(stmt.Name); ok {
				return fmt.Errorf("fixed-sum Core lowering does not support whole-value assignment for %s", stmt.Name)
			}
			if _, ok := env.lookupFixedRef(stmt.Name); ok {
				return fmt.Errorf("local reference %s cannot be reassigned during Core lowering", stmt.Name)
			}
			if _, ok := env.lookupStorageRef(stmt.Name); ok {
				return fmt.Errorf("storage reference %s cannot be reassigned during Core lowering", stmt.Name)
			}
			dest, ok := env.lookup(stmt.Name)
			if !ok {
				return fmt.Errorf("assignment to unknown local %s", stmt.Name)
			}
			value, err := b.expression(*stmt.Value, env)
			if err != nil {
				return err
			}
			if err := b.move(dest, value, stmt.Location); err != nil {
				return err
			}
		case "expr":
			if _, err := b.expression(*stmt.Value, env); err != nil {
				return err
			}
		case "return":
			if b.vecResult {
				if stmt.Value == nil || stmt.Value.Kind != "variable" {
					return fmt.Errorf("vec return ABI requires returning a local vec binding")
				}
				vec, ok := env.lookupStorageVec(stmt.Value.Name)
				if !ok || !hirTypeEqualForLowering(vec.typ, b.hirResult) {
					return fmt.Errorf("vec return ABI requires storage-backed %s local, got %s", b.hirResult.String(), stmt.Value.Name)
				}
				handle, err := b.packStorageVecDescriptor(vec, stmt.Location)
				if err != nil {
					return err
				}
				if err := b.emitAllDeferredVecDrops(env, stmt.Location); err != nil {
					return err
				}
				b.terminate(coreir.Terminator{Op: "return", Value: handle, Location: coreLocation(stmt.Location)})
				continue
			}
			value, err := b.expression(*stmt.Value, env)
			if err != nil {
				return err
			}
			if err := b.emitAllDeferredVecDrops(env, stmt.Location); err != nil {
				return err
			}
			b.terminate(coreir.Terminator{Op: "return", Value: value, Location: coreLocation(stmt.Location)})
		case "if":
			condition, err := b.expression(*stmt.Value, env)
			if err != nil {
				return err
			}
			conditionBlock := b.current
			yes, err := b.newBlock()
			if err != nil {
				return err
			}
			no, err := b.newBlock()
			if err != nil {
				return err
			}
			join, err := b.newBlock()
			if err != nil {
				return err
			}
			// newBlock updates current; the condition expression may itself have
			// appended CFG blocks, so preserve its actual current block explicitly.
			b.current = conditionBlock
			b.terminate(coreir.Terminator{Op: "branch", Value: condition, Targets: []int{yes, no}, Location: coreLocation(stmt.Location)})
			b.current = yes
			if err := b.block(stmt.Body, env); err != nil {
				return err
			}
			if !b.closed() {
				b.jump(join, stmt.Location)
			}
			b.current = no
			if err := b.block(stmt.Else, env); err != nil {
				return err
			}
			if !b.closed() {
				b.jump(join, stmt.Location)
			}
			b.current = join
		case "while":
			preheader := b.current
			head, err := b.newBlock()
			if err != nil {
				return err
			}
			bodyBlock, err := b.newBlock()
			if err != nil {
				return err
			}
			end, err := b.newBlock()
			if err != nil {
				return err
			}
			b.current = preheader
			b.jump(head, stmt.Location)
			b.current = head
			condition, err := b.expression(*stmt.Value, env)
			if err != nil {
				return err
			}
			b.terminate(coreir.Terminator{Op: "branch", Value: condition, Targets: []int{bodyBlock, end}, Location: coreLocation(stmt.Location)})
			b.current = bodyBlock
			if err := b.block(stmt.Body, env); err != nil {
				return err
			}
			if !b.closed() {
				b.jump(head, stmt.Location)
			}
			b.current = end
		default:
			return fmt.Errorf("unsupported HIR statement %s", stmt.Kind)
		}
	}
	if !b.closed() {
		if err := b.emitDeferredVecDrops(env, hir.Location{}); err != nil {
			return err
		}
	}
	return nil
}

func (b *builder) fixedSliceLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Type.Name != "slice" || len(stmt.Type.Args) != 1 || stmt.Value.Kind != "slice" || len(stmt.Value.Args) != 3 {
		return fmt.Errorf("invalid fixed-slice binding %s", stmt.Name)
	}
	base := stmt.Value.Args[0]
	if base.Kind != "variable" {
		return fmt.Errorf("fixed-slice Core lowering requires a local fixed-array base")
	}
	if storageVec, ok := env.lookupStorageVec(base.Name); ok {
		return b.storageVecSliceLet(stmt, env, storageVec)
	}
	if storageArray, ok := env.lookupStorageArray(base.Name); ok {
		return b.storageSliceLet(stmt, env, storageArray)
	}
	array, ok := env.lookupFixedArray(base.Name)
	if !ok {
		return fmt.Errorf("fixed-slice Core lowering cannot resolve fixed array %s", base.Name)
	}
	if len(array.typ.Args) != 1 || !hirTypeEqualForLowering(array.typ.Args[0], stmt.Type.Args[0]) {
		return fmt.Errorf("fixed-slice element type mismatch")
	}
	start, startConst := constantHIRU64(stmt.Value.Args[1])
	end, endConst := constantHIRU64(stmt.Value.Args[2])
	if startConst && endConst {
		if start > end || end > uint64(len(array.slots)) {
			return fmt.Errorf("fixed-slice range [%d:%d] out of bounds for length %d", start, end, len(array.slots))
		}
		env.fixedSlices[stmt.Name] = fixedSliceLocal{typ: *stmt.Type, slots: append([]int(nil), array.slots[int(start):int(end)]...), startSlot: -1, endSlot: -1}
		return nil
	}
	startSlot, err := b.expression(stmt.Value.Args[1], env)
	if err != nil {
		return err
	}
	endSlot, err := b.expression(stmt.Value.Args[2], env)
	if err != nil {
		return err
	}
	if !b.isU64Slot(startSlot) || !b.isU64Slot(endSlot) {
		return fmt.Errorf("fixed-slice dynamic range bounds must lower to u64")
	}
	if err := b.guardU64Relation("le", startSlot, endSlot, stmt.Location); err != nil {
		return err
	}
	lengthSlot, err := b.u64Constant(uint64(len(array.slots)), stmt.Location)
	if err != nil {
		return err
	}
	if err := b.guardU64Relation("le", endSlot, lengthSlot, stmt.Location); err != nil {
		return err
	}
	env.fixedSlices[stmt.Name] = fixedSliceLocal{
		typ: *stmt.Type, slots: append([]int(nil), array.slots...), dynamic: true, startSlot: startSlot, endSlot: endSlot,
	}
	return nil
}

func (b *builder) storageSliceLet(stmt hir.Statement, env *scope, array storageArrayLocal) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Type.Name != "slice" || len(stmt.Type.Args) != 1 || len(stmt.Value.Args) != 3 {
		return fmt.Errorf("invalid storage-slice binding %s", stmt.Name)
	}
	if len(array.typ.Args) != 1 || !storageRawScalarType(array.typ.Args[0]) || !hirTypeEqualForLowering(stmt.Type.Args[0], array.typ.Args[0]) {
		return fmt.Errorf("storage-slice lowering does not support element type %s", stmt.Type.Args[0].String())
	}
	start, startConst := constantHIRU64(stmt.Value.Args[1])
	end, endConst := constantHIRU64(stmt.Value.Args[2])
	var startSlot, endSlot int
	var err error
	if startConst {
		startSlot, err = b.u64Constant(start, stmt.Location)
	} else {
		startSlot, err = b.expression(stmt.Value.Args[1], env)
	}
	if err != nil {
		return err
	}
	if endConst {
		endSlot, err = b.u64Constant(end, stmt.Location)
	} else {
		endSlot, err = b.expression(stmt.Value.Args[2], env)
	}
	if err != nil {
		return err
	}
	if !b.isU64Slot(startSlot) || !b.isU64Slot(endSlot) {
		return fmt.Errorf("storage-slice bounds must lower to u64")
	}
	if startConst && endConst {
		if start > end || end > array.length {
			return fmt.Errorf("storage-slice range [%d:%d] out of bounds for length %d", start, end, array.length)
		}
	} else {
		if err := b.guardU64Relation("le", startSlot, endSlot, stmt.Location); err != nil {
			return err
		}
		lengthSlot, err := b.u64Constant(array.length, stmt.Location)
		if err != nil {
			return err
		}
		if err := b.guardU64Relation("le", endSlot, lengthSlot, stmt.Location); err != nil {
			return err
		}
	}
	env.storageSlices[stmt.Name] = storageSliceLocal{typ: *stmt.Type, idSlot: array.idSlot, startSlot: startSlot, endSlot: endSlot}
	return nil
}

func (b *builder) storageVecSliceLet(stmt hir.Statement, env *scope, vec storageVecLocal) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Type.Name != "slice" || len(stmt.Type.Args) != 1 || len(stmt.Value.Args) != 3 {
		return fmt.Errorf("invalid storage-vec slice binding %s", stmt.Name)
	}
	if len(vec.typ.Args) != 1 || !hirTypeEqualForLowering(stmt.Type.Args[0], vec.typ.Args[0]) {
		return fmt.Errorf("storage-vec slice element type %s is unsupported", stmt.Type.Args[0].String())
	}
	if _, err := storageElementLayoutFor(b.types, b.module, vec.typ.Args[0]); err != nil {
		return fmt.Errorf("storage-vec slice element type %s is unsupported: %w", stmt.Type.Args[0].String(), err)
	}
	startSlot, err := b.expression(stmt.Value.Args[1], env)
	if err != nil {
		return err
	}
	endSlot, err := b.expression(stmt.Value.Args[2], env)
	if err != nil {
		return err
	}
	if !b.isU64Slot(startSlot) || !b.isU64Slot(endSlot) {
		return fmt.Errorf("storage-vec slice bounds must lower to u64")
	}
	if err := b.guardU64Relation("le", startSlot, endSlot, stmt.Location); err != nil {
		return err
	}
	if err := b.guardU64Relation("le", endSlot, vec.lengthSlot, stmt.Location); err != nil {
		return err
	}
	env.storageSlices[stmt.Name] = storageSliceLocal{typ: *stmt.Type, idSlot: vec.idSlot, startSlot: startSlot, endSlot: endSlot}
	return nil
}

func (b *builder) isU64Slot(slot int) bool {
	return slot >= 0 && slot < len(b.f.Slots) && b.f.Slots[slot] == coreir.U64
}

func storageRawScalarType(t hir.TypeRef) bool {
	if len(t.Args) != 0 || t.Length != nil {
		return false
	}
	return t.Name == "u64" || t.Name == "i64" || t.Name == "ieee64"
}

type storageElementField struct {
	path []string
	typ  hir.TypeRef
	word uint64
}

type storageElementLayout struct {
	typ    hir.TypeRef
	words  uint64
	fields []storageElementField
	flat   bool
}

func storageElementLayoutFor(types hir.TypeTable, currentModule string, typ hir.TypeRef) (storageElementLayout, error) {
	if storageRawScalarType(typ) {
		return storageElementLayout{typ: typ, words: 1, flat: true}, nil
	}
	layout := storageElementLayout{typ: typ, flat: true}
	visiting := map[string]bool{}
	var flatten func(module string, current hir.TypeRef, prefix []string) error
	flatten = func(module string, current hir.TypeRef, prefix []string) error {
		symbol, ok := hir.ResolveType(types, module, current)
		if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") || len(symbol.Fields) == 0 {
			return fmt.Errorf("storage element layout does not support %s", current.String())
		}
		key := symbol.ID.Module + "." + symbol.ID.Name
		if visiting[key] {
			return fmt.Errorf("storage element layout rejects recursive-by-value type %s", key)
		}
		visiting[key] = true
		defer delete(visiting, key)
		for _, field := range symbol.Fields {
			path := append(append([]string(nil), prefix...), field.Name)
			if storageRawScalarType(field.Type) {
				layout.fields = append(layout.fields, storageElementField{path: path, typ: field.Type, word: layout.words})
				layout.words++
				continue
			}
			layout.flat = false
			if err := flatten(symbol.ID.Module, field.Type, path); err != nil {
				return fmt.Errorf("storage struct field %s.%s: %w", current.String(), field.Name, err)
			}
		}
		return nil
	}
	if err := flatten(currentModule, typ, nil); err != nil {
		return storageElementLayout{}, err
	}
	if layout.words == 0 {
		return storageElementLayout{}, fmt.Errorf("storage element layout %s has no raw64 leaves", typ.String())
	}
	return layout, nil
}

func storageVecType(types hir.TypeTable, currentModule string, t hir.TypeRef) bool {
	if t.Name != "vec" || len(t.Args) != 1 || t.Length != nil {
		return false
	}
	_, err := storageElementLayoutFor(types, currentModule, t.Args[0])
	return err == nil
}

func (b *builder) encodeStorageElement(expr hir.Expression, layout storageElementLayout, env *scope) ([]int, error) {
	if len(layout.fields) == 0 {
		value, err := b.expression(expr, env)
		if err != nil {
			return nil, err
		}
		raw, err := b.encodeStorageScalar(value, layout.typ, expr.Location)
		if err != nil {
			return nil, err
		}
		return []int{raw}, nil
	}
	if expr.Kind != "struct" || !hirTypeEqualForLowering(expr.Type, layout.typ) {
		return nil, fmt.Errorf("storage struct element requires %s constructor", layout.typ.String())
	}
	raw := make([]int, len(layout.fields))
	for i, field := range layout.fields {
		valueExpr, ok := storageStructLeafExpression(expr, field.path)
		if !ok {
			return nil, fmt.Errorf("storage struct element %s is missing leaf %s", layout.typ.String(), strings.Join(field.path, "."))
		}
		value, err := b.expression(valueExpr, env)
		if err != nil {
			return nil, fmt.Errorf("storage struct field %s.%s: %w", layout.typ.String(), strings.Join(field.path, "."), err)
		}
		raw[i], err = b.encodeStorageScalar(value, field.typ, valueExpr.Location)
		if err != nil {
			return nil, fmt.Errorf("storage struct field %s.%s: %w", layout.typ.String(), strings.Join(field.path, "."), err)
		}
	}
	return raw, nil
}

func storageStructLeafExpression(expr hir.Expression, path []string) (hir.Expression, bool) {
	if len(path) == 0 || expr.Kind != "struct" {
		return hir.Expression{}, false
	}
	for _, field := range expr.Fields {
		if field.Name != path[0] {
			continue
		}
		if len(path) == 1 {
			return field.Value, true
		}
		return storageStructLeafExpression(field.Value, path[1:])
	}
	return hir.Expression{}, false
}

func storageFieldPathKey(path []string) string { return strings.Join(path, ".") }

func storageIndexedFieldPlace(expr hir.Expression) (baseName string, index hir.Expression, path []string, ok bool) {
	cur := expr
	for cur.Kind == "field" && len(cur.Args) == 1 {
		path = append(path, cur.Name)
		cur = cur.Args[0]
	}
	if cur.Kind != "index" || len(cur.Args) != 2 || cur.Args[0].Kind != "variable" || len(path) == 0 {
		return "", hir.Expression{}, nil, false
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return cur.Args[0].Name, cur.Args[1], path, true
}

func storageLayoutField(layout storageElementLayout, path []string) (storageElementField, bool) {
	want := storageFieldPathKey(path)
	for _, field := range layout.fields {
		if storageFieldPathKey(field.path) == want {
			return field, true
		}
	}
	return storageElementField{}, false
}

func (b *builder) scaleStorageCount(value int, words uint64, loc hir.Location) (int, error) {
	if words == 0 {
		return -1, fmt.Errorf("storage element stride cannot be zero")
	}
	if words == 1 {
		return value, nil
	}
	max, err := b.u64Constant(^uint64(0)/words, loc)
	if err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("le", value, max, loc); err != nil {
		return -1, err
	}
	stride, err := b.u64Constant(words, loc)
	if err != nil {
		return -1, err
	}
	out, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "mul", Dest: out, Args: []int{value, stride}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	return out, nil
}

func (b *builder) storageElementWordIndex(elementIndex int, words, fieldWord uint64, loc hir.Location) (int, error) {
	if words == 0 || fieldWord >= words {
		return -1, fmt.Errorf("invalid storage element word offset %d/%d", fieldWord, words)
	}
	if words == 1 {
		return elementIndex, nil
	}
	max := (^uint64(0) - (words - 1)) / words
	maxSlot, err := b.u64Constant(max, loc)
	if err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("le", elementIndex, maxSlot, loc); err != nil {
		return -1, err
	}
	stride, err := b.u64Constant(words, loc)
	if err != nil {
		return -1, err
	}
	base, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "mul", Dest: base, Args: []int{elementIndex, stride}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	if fieldWord == 0 {
		return base, nil
	}
	offset, err := b.u64Constant(fieldWord, loc)
	if err != nil {
		return -1, err
	}
	out, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: out, Args: []int{base, offset}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	return out, nil
}

func (b *builder) packStorageVecDescriptor(vec storageVecLocal, loc hir.Location) (int, error) {
	three, err := b.u64Constant(3, loc)
	if err != nil {
		return -1, err
	}
	handle, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.alloc_u64", Dest: handle, Args: []int{three}, MayTrap: true, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	values := []int{vec.idSlot, vec.lengthSlot, vec.capacitySlot}
	for i, value := range values {
		index, err := b.u64Constant(uint64(i), loc)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{handle, index, value}, MayTrap: true, Location: coreLocation(loc)}); err != nil {
			return -1, err
		}
	}
	return handle, nil
}

func (b *builder) storageVecCallLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || !storageVecType(b.types, b.module, *stmt.Type) || stmt.Value.Kind != "call" || stmt.Value.Callee == nil {
		return fmt.Errorf("invalid vec-return call binding %s", stmt.Name)
	}
	handle, err := b.call(*stmt.Value, env)
	if err != nil {
		return err
	}
	if handle < 0 || handle >= len(b.f.Slots) || b.f.Slots[handle] != coreir.U64 {
		return fmt.Errorf("vec-return call did not produce descriptor handle")
	}
	parts := make([]int, 3)
	for i := range parts {
		index, err := b.u64Constant(uint64(i), stmt.Location)
		if err != nil {
			return err
		}
		parts[i], err = b.slot(coreir.U64)
		if err != nil {
			return err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: parts[i], Args: []int{handle, index}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
			return err
		}
	}
	if err := b.emit(coreir.Instruction{Op: "storage.free", Dest: -1, Args: []int{handle}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
		return err
	}
	env.storageVecs[stmt.Name] = storageVecLocal{typ: *stmt.Type, idSlot: parts[0], lengthSlot: parts[1], capacitySlot: parts[2]}
	return nil
}

func (b *builder) encodeStorageScalar(slot int, typ hir.TypeRef, loc hir.Location) (int, error) {
	if slot < 0 || slot >= len(b.f.Slots) || !storageRawScalarType(typ) {
		return -1, fmt.Errorf("storage encoding does not support %s", typ.String())
	}
	switch typ.Name {
	case "u64":
		if b.f.Slots[slot] != coreir.U64 {
			return -1, fmt.Errorf("storage u64 source has Core type %s", b.f.Slots[slot])
		}
		return slot, nil
	case "i64":
		if b.f.Slots[slot] != coreir.I64 {
			return -1, fmt.Errorf("storage i64 source has Core type %s", b.f.Slots[slot])
		}
		raw, err := b.slot(coreir.U64)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "bitcast_i64_u64", Dest: raw, Args: []int{slot}, Location: coreLocation(loc)}); err != nil {
			return -1, err
		}
		return raw, nil
	case "ieee64":
		if b.f.Slots[slot] != coreir.IEEE64 {
			return -1, fmt.Errorf("storage ieee64 source has Core type %s", b.f.Slots[slot])
		}
		raw, err := b.slot(coreir.U64)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "bitcast_ieee64_u64", Dest: raw, Args: []int{slot}, Location: coreLocation(loc)}); err != nil {
			return -1, err
		}
		return raw, nil
	default:
		return -1, fmt.Errorf("storage encoding does not support %s", typ.String())
	}
}

func (b *builder) decodeStorageScalar(raw int, typ hir.TypeRef, loc hir.Location) (int, error) {
	if !b.isU64Slot(raw) || !storageRawScalarType(typ) {
		return -1, fmt.Errorf("storage decoding does not support %s", typ.String())
	}
	if typ.Name == "u64" {
		return raw, nil
	}
	destType := coreir.I64
	op := "bitcast_u64_i64"
	if typ.Name == "ieee64" {
		destType = coreir.IEEE64
		op = "bitcast_u64_ieee64"
	}
	dest, err := b.slot(destType)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{raw}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	return dest, nil
}

func (b *builder) u64Constant(value uint64, loc hir.Location) (int, error) {
	return b.literal(hir.Expression{
		Kind: "literal", Type: hir.TypeRef{Name: "u64"}, Location: loc,
		Literal: &hir.Literal{Kind: "number", Value: strconv.FormatUint(value, 10)},
	})
}

func (b *builder) guardU64Relation(op string, left, right int, loc hir.Location) error {
	if !b.isU64Slot(left) || !b.isU64Slot(right) {
		return fmt.Errorf("bounds relation %s requires u64 operands", op)
	}
	condition, err := b.slot(coreir.Bool)
	if err != nil {
		return err
	}
	if err := b.emit(coreir.Instruction{Op: op, Dest: condition, Args: []int{left, right}, Location: coreLocation(loc)}); err != nil {
		return err
	}
	origin := b.current
	okBlock, err := b.newBlock()
	if err != nil {
		return err
	}
	oobBlock, err := b.newBlock()
	if err != nil {
		return err
	}
	b.current = origin
	b.terminate(coreir.Terminator{Op: "branch", Value: condition, Targets: []int{okBlock, oobBlock}, Location: coreLocation(loc)})
	b.current = oobBlock
	b.terminate(coreir.Terminator{Op: "unreachable", Value: -1, Location: coreLocation(loc)})
	b.current = okBlock
	return nil
}

func (b *builder) fixedRefLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "borrow" || len(stmt.Type.Args) != 1 || stmt.Type.Length != nil {
		return fmt.Errorf("invalid local reference binding %s", stmt.Name)
	}
	mutable := stmt.Type.Name == "mutref"
	if mutable != (stmt.Value.Operator == "mut") {
		return fmt.Errorf("reference mutability mismatch for %s", stmt.Name)
	}
	if len(stmt.Value.Args) != 1 {
		return fmt.Errorf("borrow expression for %s requires one place", stmt.Name)
	}
	target, targetType, err := b.resolveFixedPlace(stmt.Value.Args[0], env)
	if err != nil {
		return fmt.Errorf("reference %s: %w", stmt.Name, err)
	}
	if !hirTypeEqualForLowering(targetType, stmt.Type.Args[0]) {
		return fmt.Errorf("reference %s target type %s does not match %s", stmt.Name, targetType.String(), stmt.Type.Args[0].String())
	}
	env.fixedRefs[stmt.Name] = fixedRefLocal{typ: *stmt.Type, targetSlot: target, mutable: mutable}
	return nil
}

func (b *builder) storageRefPlaceSupported(borrow hir.Expression, env *scope) bool {
	if borrow.Kind != "borrow" || len(borrow.Args) != 1 {
		return false
	}
	place := borrow.Args[0]
	if baseName, _, path, ok := storageIndexedFieldPlace(place); ok {
		var elementType hir.TypeRef
		if vec, ok := env.lookupStorageVec(baseName); ok && len(vec.typ.Args) == 1 {
			elementType = vec.typ.Args[0]
		} else if slice, ok := env.lookupStorageSlice(baseName); ok && len(slice.typ.Args) == 1 {
			elementType = slice.typ.Args[0]
		} else {
			return false
		}
		layout, err := storageElementLayoutFor(b.types, b.module, elementType)
		if err != nil || len(layout.fields) == 0 {
			return false
		}
		_, found := storageLayoutField(layout, path)
		return found
	}
	if place.Kind != "index" || len(place.Args) != 2 || place.Args[0].Kind != "variable" {
		return false
	}
	if _, ok := env.lookupStorageVec(place.Args[0].Name); ok {
		return true
	}
	_, ok := env.lookupStorageArray(place.Args[0].Name)
	return ok
}

func (b *builder) storageRefLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "borrow" || len(stmt.Type.Args) != 1 || stmt.Type.Length != nil {
		return fmt.Errorf("invalid storage reference binding %s", stmt.Name)
	}
	mutable := stmt.Type.Name == "mutref"
	if mutable != (stmt.Value.Operator == "mut") {
		return fmt.Errorf("storage reference mutability mismatch for %s", stmt.Name)
	}
	place := stmt.Value.Args[0]
	if baseName, indexExpr, path, ok := storageIndexedFieldPlace(place); ok {
		var idSlot int
		var elementIndex int
		var elementType hir.TypeRef
		if vec, ok := env.lookupStorageVec(baseName); ok && len(vec.typ.Args) == 1 {
			elementType = vec.typ.Args[0]
			idSlot = vec.idSlot
			var err error
			elementIndex, err = b.expression(indexExpr, env)
			if err != nil {
				return err
			}
			if !b.isU64Slot(elementIndex) {
				return fmt.Errorf("storage reference index must lower to u64")
			}
			if err := b.guardU64Relation("lt", elementIndex, vec.lengthSlot, stmt.Location); err != nil {
				return err
			}
		} else if slice, ok := env.lookupStorageSlice(baseName); ok && len(slice.typ.Args) == 1 {
			if mutable {
				return fmt.Errorf("mutable reference through slice<T> requires an explicit mutable-slice contract")
			}
			elementType = slice.typ.Args[0]
			idSlot = slice.idSlot
			var err error
			elementIndex, err = b.storageSliceAbsoluteElementIndex(slice, indexExpr, stmt.Location, env)
			if err != nil {
				return err
			}
		} else {
			return fmt.Errorf("storage reference %s cannot resolve storage place %s", stmt.Name, baseName)
		}
		layout, err := storageElementLayoutFor(b.types, b.module, elementType)
		if err != nil || len(layout.fields) == 0 {
			return fmt.Errorf("storage reference %s requires a raw64-leaf struct element", stmt.Name)
		}
		field, found := storageLayoutField(layout, path)
		if !found || !hirTypeEqualForLowering(stmt.Type.Args[0], field.typ) {
			return fmt.Errorf("storage reference %s field %s type mismatch", stmt.Name, storageFieldPathKey(path))
		}
		wordIndex, err := b.storageElementWordIndex(elementIndex, layout.words, field.word, stmt.Location)
		if err != nil {
			return err
		}
		env.storageRefs[stmt.Name] = storageRefLocal{typ: *stmt.Type, idSlot: idSlot, indexSlot: wordIndex, mutable: mutable}
		return nil
	}
	if place.Kind != "index" || len(place.Args) != 2 || place.Args[0].Kind != "variable" {
		return fmt.Errorf("storage reference %s requires indexed vec place", stmt.Name)
	}
	var idSlot, lengthSlot int
	if vec, ok := env.lookupStorageVec(place.Args[0].Name); ok {
		if len(vec.typ.Args) != 1 || !storageRawScalarType(vec.typ.Args[0]) || !hirTypeEqualForLowering(stmt.Type.Args[0], vec.typ.Args[0]) {
			return fmt.Errorf("storage reference lowering does not support %s", stmt.Type.String())
		}
		idSlot, lengthSlot = vec.idSlot, vec.lengthSlot
	} else if array, ok := env.lookupStorageArray(place.Args[0].Name); ok {
		if len(array.typ.Args) != 1 || !storageRawScalarType(array.typ.Args[0]) || !hirTypeEqualForLowering(stmt.Type.Args[0], array.typ.Args[0]) {
			return fmt.Errorf("storage array reference lowering does not support %s", stmt.Type.String())
		}
		idSlot = array.idSlot
		var err error
		lengthSlot, err = b.u64Constant(array.length, stmt.Location)
		if err != nil {
			return err
		}
	} else {
		return fmt.Errorf("storage reference %s cannot resolve storage place %s", stmt.Name, place.Args[0].Name)
	}
	indexSlot, err := b.expression(place.Args[1], env)
	if err != nil {
		return err
	}
	if !b.isU64Slot(indexSlot) {
		return fmt.Errorf("storage reference index must lower to u64")
	}
	if err := b.guardU64Relation("lt", indexSlot, lengthSlot, stmt.Location); err != nil {
		return err
	}
	env.storageRefs[stmt.Name] = storageRefLocal{typ: *stmt.Type, idSlot: idSlot, indexSlot: indexSlot, mutable: mutable}
	return nil
}

func (b *builder) resolveFixedPlace(expr hir.Expression, env *scope) (int, hir.TypeRef, error) {
	switch expr.Kind {
	case "variable":
		slot, ok := env.lookup(expr.Name)
		if !ok {
			return -1, hir.TypeRef{}, fmt.Errorf("place %s is not a Core scalar local", expr.Name)
		}
		return slot, expr.Type, nil
	case "field":
		baseName, path, ok := fixedStructFieldPlace(expr)
		if !ok {
			return -1, hir.TypeRef{}, fmt.Errorf("field borrow requires a fixed local struct leaf path")
		}
		value, ok := env.lookupFixedStruct(baseName)
		if !ok {
			return -1, hir.TypeRef{}, fmt.Errorf("cannot resolve fixed struct %s", baseName)
		}
		key := storageFieldPathKey(path)
		slot, ok := value.fields[key]
		if !ok {
			return -1, hir.TypeRef{}, fmt.Errorf("fixed struct %s has no scalarized leaf %s", value.typ.String(), key)
		}
		return slot, expr.Type, nil
	case "index":
		if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
			return -1, hir.TypeRef{}, fmt.Errorf("indexed borrow requires a fixed local array base")
		}
		array, ok := env.lookupFixedArray(expr.Args[0].Name)
		if !ok {
			return -1, hir.TypeRef{}, fmt.Errorf("cannot resolve fixed array %s", expr.Args[0].Name)
		}
		index, constant := constantHIRU64(expr.Args[1])
		if !constant {
			return -1, hir.TypeRef{}, fmt.Errorf("indexed reference lowering requires a compile-time u64 index")
		}
		if index >= uint64(len(array.slots)) {
			return -1, hir.TypeRef{}, fmt.Errorf("fixed-array reference index %d out of bounds for length %d", index, len(array.slots))
		}
		return array.slots[index], expr.Type, nil
	default:
		return -1, hir.TypeRef{}, fmt.Errorf("unsupported reference place %s", expr.Kind)
	}
}

func (b *builder) fixedSumLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "enum" {
		return fmt.Errorf("invalid fixed-sum local")
	}
	payloadType, hasPayload, err := b.sumVariantPayload(*stmt.Type, stmt.Value.Name)
	if err != nil {
		return err
	}
	local := fixedSumLocal{typ: *stmt.Type, variant: stmt.Value.Name, payloadSlot: -1}
	if !hasPayload {
		if len(stmt.Value.Args) != 0 {
			return fmt.Errorf("fixed-sum variant %s unexpectedly has payload", stmt.Value.Name)
		}
		env.fixedSums[stmt.Name] = local
		return nil
	}
	if len(stmt.Value.Args) != 1 {
		return fmt.Errorf("fixed-sum variant %s requires one payload", stmt.Value.Name)
	}
	corePayloadType, err := coreType(payloadType)
	if err != nil {
		return fmt.Errorf("fixed-sum payload %s: %w", payloadType.String(), err)
	}
	if corePayloadType == coreir.Void {
		return fmt.Errorf("fixed-sum payload cannot be void")
	}
	value, err := b.expression(stmt.Value.Args[0], env)
	if err != nil {
		return fmt.Errorf("fixed-sum payload: %w", err)
	}
	if value < 0 || value >= len(b.f.Slots) || b.f.Slots[value] != corePayloadType {
		return fmt.Errorf("fixed-sum payload lowered with incompatible Core type")
	}
	dest, err := b.slot(corePayloadType)
	if err != nil {
		return err
	}
	if err := b.move(dest, value, stmt.Location); err != nil {
		return err
	}
	payloadCopy := payloadType
	local.payloadSlot = dest
	local.payloadType = &payloadCopy
	env.fixedSums[stmt.Name] = local
	return nil
}

func (b *builder) sumVariantPayload(typ hir.TypeRef, variant string) (hir.TypeRef, bool, error) {
	switch typ.Name {
	case "option":
		if len(typ.Args) != 1 {
			return hir.TypeRef{}, false, fmt.Errorf("invalid option type %s", typ.String())
		}
		switch variant {
		case "None":
			return hir.TypeRef{}, false, nil
		case "Some":
			return typ.Args[0], true, nil
		default:
			return hir.TypeRef{}, false, fmt.Errorf("option has no variant %s", variant)
		}
	case "result":
		if len(typ.Args) != 2 {
			return hir.TypeRef{}, false, fmt.Errorf("invalid result type %s", typ.String())
		}
		switch variant {
		case "Ok":
			return typ.Args[0], true, nil
		case "Err":
			return typ.Args[1], true, nil
		default:
			return hir.TypeRef{}, false, fmt.Errorf("result has no variant %s", variant)
		}
	default:
		symbol, ok := hir.ResolveType(b.types, b.module, typ)
		if !ok || symbol.ID.Kind != "enum" {
			return hir.TypeRef{}, false, fmt.Errorf("fixed-sum Core lowering cannot resolve enum %s", typ.String())
		}
		for _, candidate := range symbol.Variants {
			if candidate.Name != variant {
				continue
			}
			if candidate.Payload == nil {
				return hir.TypeRef{}, false, nil
			}
			return *candidate.Payload, true, nil
		}
		return hir.TypeRef{}, false, fmt.Errorf("enum %s has no variant %s", typ.String(), variant)
	}
}

func (b *builder) fixedStructLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "struct" {
		return fmt.Errorf("invalid fixed-struct local")
	}
	symbol, ok := hir.ResolveType(b.types, b.module, *stmt.Type)
	if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") {
		return fmt.Errorf("fixed-struct Core lowering cannot resolve %s", stmt.Type.String())
	}
	if layout, err := storageElementLayoutFor(b.types, b.module, *stmt.Type); err == nil && len(layout.fields) != 0 {
		local := fixedStructLocal{typ: *stmt.Type, fields: make(map[string]int, len(layout.fields))}
		for _, leaf := range layout.fields {
			leafExpr, ok := storageStructLeafExpression(*stmt.Value, leaf.path)
			if !ok {
				return fmt.Errorf("fixed-struct %s is missing leaf %s", stmt.Type.String(), storageFieldPathKey(leaf.path))
			}
			coreLeafType, err := coreType(leaf.typ)
			if err != nil {
				return fmt.Errorf("fixed-struct leaf %s.%s: %w", stmt.Type.String(), storageFieldPathKey(leaf.path), err)
			}
			value, err := b.expression(leafExpr, env)
			if err != nil {
				return fmt.Errorf("fixed-struct leaf %s.%s: %w", stmt.Type.String(), storageFieldPathKey(leaf.path), err)
			}
			if value < 0 || value >= len(b.f.Slots) || b.f.Slots[value] != coreLeafType {
				return fmt.Errorf("fixed-struct leaf %s.%s lowered with incompatible Core type", stmt.Type.String(), storageFieldPathKey(leaf.path))
			}
			dest, err := b.slot(coreLeafType)
			if err != nil {
				return err
			}
			if err := b.move(dest, value, stmt.Location); err != nil {
				return err
			}
			local.fields[storageFieldPathKey(leaf.path)] = dest
		}
		env.fixedStructs[stmt.Name] = local
		return nil
	}
	expected := make(map[string]hir.TypeRef, len(symbol.Fields))
	for _, field := range symbol.Fields {
		expected[field.Name] = field.Type
	}
	if len(stmt.Value.Fields) != len(expected) {
		return fmt.Errorf("fixed-struct %s field count mismatch", stmt.Name)
	}
	local := fixedStructLocal{typ: *stmt.Type, fields: make(map[string]int, len(expected))}
	for _, field := range stmt.Value.Fields {
		fieldType, exists := expected[field.Name]
		if !exists {
			return fmt.Errorf("fixed-struct %s has unknown field %s", stmt.Type.String(), field.Name)
		}
		coreFieldType, err := coreType(fieldType)
		if err != nil {
			return fmt.Errorf("fixed-struct field %s.%s: %w", stmt.Type.String(), field.Name, err)
		}
		if coreFieldType == coreir.Void {
			return fmt.Errorf("fixed-struct field %s.%s cannot be void", stmt.Type.String(), field.Name)
		}
		value, err := b.expression(field.Value, env)
		if err != nil {
			return fmt.Errorf("fixed-struct field %s.%s: %w", stmt.Type.String(), field.Name, err)
		}
		if value < 0 || value >= len(b.f.Slots) || b.f.Slots[value] != coreFieldType {
			return fmt.Errorf("fixed-struct field %s.%s lowered with incompatible Core type", stmt.Type.String(), field.Name)
		}
		dest, err := b.slot(coreFieldType)
		if err != nil {
			return err
		}
		if err := b.move(dest, value, stmt.Location); err != nil {
			return err
		}
		local.fields[field.Name] = dest
	}
	env.fixedStructs[stmt.Name] = local
	return nil
}

func (b *builder) fixedArrayLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Type.Name != "array" || len(stmt.Type.Args) != 1 || stmt.Type.Length == nil {
		return fmt.Errorf("invalid fixed-array local type")
	}
	if stmt.Value == nil || stmt.Value.Kind != "array" {
		return fmt.Errorf("fixed-array Core lowering currently requires an array literal initializer for %s", stmt.Name)
	}
	if uint64(len(stmt.Value.Args)) != *stmt.Type.Length {
		return fmt.Errorf("fixed-array initializer length %d does not match %d", len(stmt.Value.Args), *stmt.Type.Length)
	}
	elementType, err := coreType(stmt.Type.Args[0])
	if err != nil {
		return fmt.Errorf("fixed-array element type %s: %w", stmt.Type.Args[0].String(), err)
	}
	if elementType == coreir.Void {
		return fmt.Errorf("fixed-array element type cannot be void")
	}
	if *stmt.Type.Length > maxScalarizedDynamicArrayLength {
		if !storageRawScalarType(stmt.Type.Args[0]) {
			return fmt.Errorf("storage-backed fixed-array lowering currently supports u64/i64 elements, got %s", elementType)
		}
		return b.storageArrayLet(stmt, env)
	}
	if *stmt.Type.Length > uint64(coreir.MaxSlots) || len(b.f.Slots)+len(stmt.Value.Args) > coreir.MaxSlots {
		return fmt.Errorf("fixed-array %s exceeds Core slot budget", stmt.Name)
	}
	local := fixedArrayLocal{typ: *stmt.Type, slots: make([]int, len(stmt.Value.Args))}
	for i, element := range stmt.Value.Args {
		value, err := b.expression(element, env)
		if err != nil {
			return fmt.Errorf("fixed-array %s element %d: %w", stmt.Name, i, err)
		}
		if value < 0 || value >= len(b.f.Slots) || b.f.Slots[value] != elementType {
			return fmt.Errorf("fixed-array %s element %d lowered with incompatible Core type", stmt.Name, i)
		}
		dest, err := b.slot(elementType)
		if err != nil {
			return err
		}
		if err := b.move(dest, value, stmt.Location); err != nil {
			return err
		}
		local.slots[i] = dest
	}
	env.fixedArrays[stmt.Name] = local
	return nil
}

func (b *builder) storageArrayLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Type.Length == nil || stmt.Value == nil || stmt.Value.Kind != "array" {
		return fmt.Errorf("invalid storage-array local %s", stmt.Name)
	}
	if stmt.Type.Name != "array" || len(stmt.Type.Args) != 1 || !storageRawScalarType(stmt.Type.Args[0]) {
		return fmt.Errorf("storage-array lowering supports array<u64,N>/array<i64,N>, got %s", stmt.Type.String())
	}
	lengthSlot, err := b.u64Constant(*stmt.Type.Length, stmt.Location)
	if err != nil {
		return err
	}
	idSlot, err := b.slot(coreir.U64)
	if err != nil {
		return err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.alloc_u64", Dest: idSlot, Args: []int{lengthSlot}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
		return err
	}
	for i, element := range stmt.Value.Args {
		value, err := b.expression(element, env)
		if err != nil {
			return fmt.Errorf("storage-array %s element %d: %w", stmt.Name, i, err)
		}
		raw, err := b.encodeStorageScalar(value, stmt.Type.Args[0], element.Location)
		if err != nil {
			return fmt.Errorf("storage-array %s element %d: %w", stmt.Name, i, err)
		}
		indexSlot, err := b.u64Constant(uint64(i), stmt.Location)
		if err != nil {
			return err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{idSlot, indexSlot, raw}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
			return err
		}
	}
	env.storageArrays[stmt.Name] = storageArrayLocal{typ: *stmt.Type, idSlot: idSlot, length: *stmt.Type.Length}
	return nil
}

func (b *builder) storageVecLet(stmt hir.Statement, env *scope) error {
	if stmt.Type == nil || stmt.Type.Name != "vec" || len(stmt.Type.Args) != 1 || stmt.Type.Length != nil || stmt.Value == nil || stmt.Value.Kind != "vec" {
		return fmt.Errorf("invalid storage-vec local %s", stmt.Name)
	}
	layout, err := storageElementLayoutFor(b.types, b.module, stmt.Type.Args[0])
	if err != nil {
		return fmt.Errorf("storage-vec %s: %w", stmt.Name, err)
	}
	length := uint64(len(stmt.Value.Args))
	if layout.words != 0 && length > ^uint64(0)/layout.words {
		return fmt.Errorf("storage-vec %s word length overflow", stmt.Name)
	}
	lengthValue, err := b.u64Constant(length, stmt.Location)
	if err != nil {
		return err
	}
	lengthSlot, err := b.slot(coreir.U64)
	if err != nil {
		return err
	}
	if err := b.move(lengthSlot, lengthValue, stmt.Location); err != nil {
		return err
	}
	capacitySlot, err := b.slot(coreir.U64)
	if err != nil {
		return err
	}
	if err := b.move(capacitySlot, lengthValue, stmt.Location); err != nil {
		return err
	}
	idSlot, err := b.slot(coreir.U64)
	if err != nil {
		return err
	}
	allocationWords, err := b.u64Constant(length*layout.words, stmt.Location)
	if err != nil {
		return err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.alloc_u64", Dest: idSlot, Args: []int{allocationWords}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
		return err
	}
	for i, element := range stmt.Value.Args {
		raw, err := b.encodeStorageElement(element, layout, env)
		if err != nil {
			return fmt.Errorf("storage-vec %s element %d: %w", stmt.Name, i, err)
		}
		for word, rawSlot := range raw {
			index := uint64(i)*layout.words + uint64(word)
			indexSlot, err := b.u64Constant(index, stmt.Location)
			if err != nil {
				return err
			}
			if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{idSlot, indexSlot, rawSlot}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
				return err
			}
		}
	}
	env.storageVecs[stmt.Name] = storageVecLocal{typ: *stmt.Type, idSlot: idSlot, lengthSlot: lengthSlot, capacitySlot: capacitySlot}
	return nil
}

func (b *builder) move(dest, src int, loc hir.Location) error {
	if dest < 0 || src < 0 || dest >= len(b.f.Slots) || src >= len(b.f.Slots) || b.f.Slots[dest] != b.f.Slots[src] {
		return fmt.Errorf("invalid Core move")
	}
	return b.emit(coreir.Instruction{Op: "move", Dest: dest, Args: []int{src}, Location: coreLocation(loc)})
}

func (b *builder) expression(expr hir.Expression, env *scope) (int, error) {
	switch expr.Kind {
	case "literal":
		return b.literal(expr)
	case "variable":
		if _, ok := env.lookupFixedArray(expr.Name); ok {
			return -1, fmt.Errorf("fixed-array value %s must be indexed before Core lowering", expr.Name)
		}
		if _, ok := env.lookupStorageArray(expr.Name); ok {
			return -1, fmt.Errorf("storage-array value %s must be indexed before Core lowering", expr.Name)
		}
		if _, ok := env.lookupStorageVec(expr.Name); ok {
			return -1, fmt.Errorf("storage-vec value %s must be indexed or consumed by drop before Core lowering", expr.Name)
		}
		if _, ok := env.lookupFixedSlice(expr.Name); ok {
			return -1, fmt.Errorf("fixed-slice value %s must be indexed before Core lowering", expr.Name)
		}
		if _, ok := env.lookupStorageSlice(expr.Name); ok {
			return -1, fmt.Errorf("storage-slice value %s must be indexed before Core lowering", expr.Name)
		}
		if _, ok := env.lookupFixedStruct(expr.Name); ok {
			return -1, fmt.Errorf("fixed-struct value %s must be projected before Core lowering", expr.Name)
		}
		if _, ok := env.lookupFixedSum(expr.Name); ok {
			return -1, fmt.Errorf("fixed-sum value %s must be matched before Core lowering", expr.Name)
		}
		if _, ok := env.lookupFixedRef(expr.Name); ok {
			return -1, fmt.Errorf("reference value %s must be dereferenced or consumed by a reference builtin", expr.Name)
		}
		if _, ok := env.lookupStorageRef(expr.Name); ok {
			return -1, fmt.Errorf("storage reference %s must be dereferenced or consumed by a reference builtin", expr.Name)
		}
		slot, ok := env.lookup(expr.Name)
		if !ok {
			return -1, fmt.Errorf("unknown local %s", expr.Name)
		}
		return slot, nil
	case "call":
		return b.call(expr, env)
	case "unary":
		return b.unary(expr, env)
	case "binary":
		return b.binary(expr, env)
	case "index":
		if len(expr.Args) == 2 && expr.Args[0].Kind == "variable" {
			if _, ok := env.lookupStorageVec(expr.Args[0].Name); ok {
				return b.storageVecIndex(expr, env)
			}
			if _, ok := env.lookupStorageSlice(expr.Args[0].Name); ok {
				return b.storageSliceIndex(expr, env)
			}
			if _, ok := env.lookupStorageArray(expr.Args[0].Name); ok {
				return b.storageArrayIndex(expr, env)
			}
			if _, ok := env.lookupFixedSlice(expr.Args[0].Name); ok {
				return b.fixedSliceIndex(expr, env)
			}
		}
		return b.fixedArrayIndex(expr, env)
	case "field":
		if baseName, _, _, ok := storageIndexedFieldPlace(expr); ok {
			if _, ok := env.lookupStorageVec(baseName); ok {
				return b.storageVecStructField(expr, env)
			}
			if _, ok := env.lookupStorageSlice(baseName); ok {
				return b.storageSliceStructField(expr, env)
			}
		}
		return b.fixedStructField(expr, env)
	case "match":
		return b.fixedSumMatch(expr, env)
	case "deref":
		if len(expr.Args) == 1 && expr.Args[0].Kind == "variable" {
			if _, ok := env.lookupStorageRef(expr.Args[0].Name); ok {
				return b.storageRefDeref(expr, env)
			}
		}
		return b.fixedRefDeref(expr, env)
	default:
		return -1, fmt.Errorf("unsupported HIR expression %s", expr.Kind)
	}
}

func (b *builder) storageArrayIndex(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("storage-array Core lowering requires indexing a local array variable")
	}
	array, ok := env.lookupStorageArray(expr.Args[0].Name)
	if !ok {
		return -1, fmt.Errorf("cannot resolve storage array %s", expr.Args[0].Name)
	}
	if len(array.typ.Args) != 1 || !storageRawScalarType(array.typ.Args[0]) || !hirTypeEqualForLowering(expr.Type, array.typ.Args[0]) {
		return -1, fmt.Errorf("storage-array indexing does not support element type %s", expr.Type.String())
	}
	indexSlot, err := b.expression(expr.Args[1], env)
	if err != nil {
		return -1, err
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("storage-array index must lower to u64")
	}
	result, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: result, Args: []int{array.idSlot, indexSlot}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(result, expr.Type, expr.Location)
}

func (b *builder) storageVecIndex(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("storage-vec Core lowering requires indexing a local vec variable")
	}
	vec, ok := env.lookupStorageVec(expr.Args[0].Name)
	if !ok {
		return -1, fmt.Errorf("cannot resolve storage vec %s", expr.Args[0].Name)
	}
	if len(vec.typ.Args) != 1 || !storageRawScalarType(vec.typ.Args[0]) || !hirTypeEqualForLowering(expr.Type, vec.typ.Args[0]) {
		return -1, fmt.Errorf("storage-vec indexing does not support element type %s", expr.Type.String())
	}
	indexSlot, err := b.expression(expr.Args[1], env)
	if err != nil {
		return -1, err
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("storage-vec index must lower to u64")
	}
	if err := b.guardU64Relation("lt", indexSlot, vec.lengthSlot, expr.Location); err != nil {
		return -1, err
	}
	result, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: result, Args: []int{vec.idSlot, indexSlot}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(result, expr.Type, expr.Location)
}

func (b *builder) storageSliceIndex(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("storage-slice Core lowering requires indexing a local slice variable")
	}
	slice, ok := env.lookupStorageSlice(expr.Args[0].Name)
	if !ok {
		return -1, fmt.Errorf("cannot resolve storage slice %s", expr.Args[0].Name)
	}
	if len(slice.typ.Args) != 1 || !storageRawScalarType(slice.typ.Args[0]) || !hirTypeEqualForLowering(expr.Type, slice.typ.Args[0]) {
		return -1, fmt.Errorf("storage-slice indexing does not support element type %s", expr.Type.String())
	}
	indexSlot, err := b.expression(expr.Args[1], env)
	if err != nil {
		return -1, err
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("storage-slice index must lower to u64")
	}
	lengthSlot, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "sub", Dest: lengthSlot, Args: []int{slice.endSlot, slice.startSlot}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("lt", indexSlot, lengthSlot, expr.Location); err != nil {
		return -1, err
	}
	absolute, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: absolute, Args: []int{slice.startSlot, indexSlot}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	result, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: result, Args: []int{slice.idSlot, absolute}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(result, expr.Type, expr.Location)
}

func (b *builder) storageSliceAbsoluteElementIndex(slice storageSliceLocal, indexExpr hir.Expression, loc hir.Location, env *scope) (int, error) {
	indexSlot, err := b.expression(indexExpr, env)
	if err != nil {
		return -1, err
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("storage-slice index must lower to u64")
	}
	lengthSlot, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "sub", Dest: lengthSlot, Args: []int{slice.endSlot, slice.startSlot}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("lt", indexSlot, lengthSlot, loc); err != nil {
		return -1, err
	}
	absolute, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: absolute, Args: []int{slice.startSlot, indexSlot}, Location: coreLocation(loc)}); err != nil {
		return -1, err
	}
	return absolute, nil
}

func (b *builder) storageSliceStructField(expr hir.Expression, env *scope) (int, error) {
	sliceName, indexExpr, path, ok := storageIndexedFieldPlace(expr)
	if !ok {
		return -1, fmt.Errorf("storage-slice struct field requires s[index].field path")
	}
	slice, ok := env.lookupStorageSlice(sliceName)
	if !ok || len(slice.typ.Args) != 1 {
		return -1, fmt.Errorf("cannot resolve storage slice %s", sliceName)
	}
	layout, err := storageElementLayoutFor(b.types, b.module, slice.typ.Args[0])
	if err != nil || len(layout.fields) == 0 {
		return -1, fmt.Errorf("storage-slice %s element type is not a supported struct layout", sliceName)
	}
	field, found := storageLayoutField(layout, path)
	if !found || !hirTypeEqualForLowering(field.typ, expr.Type) {
		return -1, fmt.Errorf("storage slice struct %s has no compatible field %s", layout.typ.String(), storageFieldPathKey(path))
	}
	absoluteElement, err := b.storageSliceAbsoluteElementIndex(slice, indexExpr, expr.Location, env)
	if err != nil {
		return -1, err
	}
	wordIndex, err := b.storageElementWordIndex(absoluteElement, layout.words, field.word, expr.Location)
	if err != nil {
		return -1, err
	}
	raw, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: raw, Args: []int{slice.idSlot, wordIndex}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(raw, field.typ, expr.Location)
}

func (b *builder) storageSliceStructCopySupported(stmt hir.Statement, env *scope) bool {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "index" || len(stmt.Value.Args) != 2 || stmt.Value.Args[0].Kind != "variable" {
		return false
	}
	slice, ok := env.lookupStorageSlice(stmt.Value.Args[0].Name)
	if !ok || len(slice.typ.Args) != 1 || !hirTypeEqualForLowering(*stmt.Type, slice.typ.Args[0]) {
		return false
	}
	layout, err := storageElementLayoutFor(b.types, b.module, slice.typ.Args[0])
	return err == nil && len(layout.fields) != 0
}

func (b *builder) storageSliceStructCopyLet(stmt hir.Statement, env *scope) error {
	if !b.storageSliceStructCopySupported(stmt, env) {
		return fmt.Errorf("invalid storage-slice struct copy binding %s", stmt.Name)
	}
	indexExpr := *stmt.Value
	slice, _ := env.lookupStorageSlice(indexExpr.Args[0].Name)
	layout, err := storageElementLayoutFor(b.types, b.module, slice.typ.Args[0])
	if err != nil {
		return err
	}
	absoluteElement, err := b.storageSliceAbsoluteElementIndex(slice, indexExpr.Args[1], stmt.Location, env)
	if err != nil {
		return err
	}
	local := fixedStructLocal{typ: *stmt.Type, fields: make(map[string]int, len(layout.fields))}
	for _, field := range layout.fields {
		wordIndex, err := b.storageElementWordIndex(absoluteElement, layout.words, field.word, stmt.Location)
		if err != nil {
			return err
		}
		raw, err := b.slot(coreir.U64)
		if err != nil {
			return err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: raw, Args: []int{slice.idSlot, wordIndex}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
			return err
		}
		value, err := b.decodeStorageScalar(raw, field.typ, stmt.Location)
		if err != nil {
			return err
		}
		local.fields[storageFieldPathKey(field.path)] = value
	}
	env.fixedStructs[stmt.Name] = local
	return nil
}

func (b *builder) fixedRefDeref(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 1 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("reference dereference requires a local ref/mutref binding")
	}
	ref, ok := env.lookupFixedRef(expr.Args[0].Name)
	if !ok {
		return -1, fmt.Errorf("cannot resolve local reference %s", expr.Args[0].Name)
	}
	if len(ref.typ.Args) != 1 || !hirTypeEqualForLowering(expr.Type, ref.typ.Args[0]) {
		return -1, fmt.Errorf("dereference type mismatch for %s", expr.Args[0].Name)
	}
	return ref.targetSlot, nil
}

func (b *builder) storageRefDeref(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 1 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("storage dereference requires local ref/mutref binding")
	}
	ref, ok := env.lookupStorageRef(expr.Args[0].Name)
	if !ok {
		return -1, fmt.Errorf("cannot resolve storage reference %s", expr.Args[0].Name)
	}
	if len(ref.typ.Args) != 1 || !storageRawScalarType(ref.typ.Args[0]) || !hirTypeEqualForLowering(expr.Type, ref.typ.Args[0]) {
		return -1, fmt.Errorf("storage dereference does not support %s", expr.Type.String())
	}
	result, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: result, Args: []int{ref.idSlot, ref.indexSlot}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(result, expr.Type, expr.Location)
}

func (b *builder) fixedSumMatch(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 1 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("fixed-sum Core lowering requires matching a local sum variable")
	}
	baseName := expr.Args[0].Name
	value, ok := env.lookupFixedSum(baseName)
	if !ok {
		return -1, fmt.Errorf("fixed-sum Core lowering cannot resolve local %s", baseName)
	}
	for _, arm := range expr.Arms {
		if arm.Variant != value.variant {
			continue
		}
		armEnv := &scope{
			slots: map[string]int{}, fixedArrays: map[string]fixedArrayLocal{}, storageArrays: map[string]storageArrayLocal{}, fixedSlices: map[string]fixedSliceLocal{}, storageSlices: map[string]storageSliceLocal{},
			fixedStructs: map[string]fixedStructLocal{}, fixedSums: map[string]fixedSumLocal{}, fixedRefs: map[string]fixedRefLocal{}, parent: env,
		}
		if arm.Binding != "" {
			if value.payloadSlot < 0 || value.payloadType == nil {
				return -1, fmt.Errorf("fixed-sum arm %s binds missing payload", arm.Variant)
			}
			armEnv.slots[arm.Binding] = value.payloadSlot
		} else if value.payloadSlot >= 0 {
			return -1, fmt.Errorf("fixed-sum payload variant %s requires binding", arm.Variant)
		}
		return b.expression(arm.Value, armEnv)
	}
	return -1, fmt.Errorf("fixed-sum match has no arm for variant %s", value.variant)
}

func (b *builder) fixedStructField(expr hir.Expression, env *scope) (int, error) {
	baseName, path, ok := fixedStructFieldPlace(expr)
	if !ok {
		return -1, fmt.Errorf("fixed-struct Core lowering requires projection from a local struct leaf path")
	}
	value, ok := env.lookupFixedStruct(baseName)
	if !ok {
		return -1, fmt.Errorf("fixed-struct Core lowering cannot resolve local %s", baseName)
	}
	key := storageFieldPathKey(path)
	slot, ok := value.fields[key]
	if !ok {
		return -1, fmt.Errorf("fixed-struct %s has no lowered leaf %s", value.typ.String(), key)
	}
	return slot, nil
}

func fixedStructFieldPlace(expr hir.Expression) (baseName string, path []string, ok bool) {
	cur := expr
	for cur.Kind == "field" && len(cur.Args) == 1 {
		path = append(path, cur.Name)
		cur = cur.Args[0]
	}
	if cur.Kind != "variable" || cur.Name == "" || len(path) == 0 {
		return "", nil, false
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return cur.Name, path, true
}

func (b *builder) storageVecStructField(expr hir.Expression, env *scope) (int, error) {
	vecName, indexExpr, path, ok := storageIndexedFieldPlace(expr)
	if !ok {
		return -1, fmt.Errorf("storage-vec struct field requires v[index].field path")
	}
	vec, ok := env.lookupStorageVec(vecName)
	if !ok || len(vec.typ.Args) != 1 {
		return -1, fmt.Errorf("cannot resolve storage vec %s", vecName)
	}
	layout, err := storageElementLayoutFor(b.types, b.module, vec.typ.Args[0])
	if err != nil || len(layout.fields) == 0 {
		return -1, fmt.Errorf("storage-vec %s element type is not a supported struct layout", vecName)
	}
	field, found := storageLayoutField(layout, path)
	if !found || !hirTypeEqualForLowering(field.typ, expr.Type) {
		return -1, fmt.Errorf("storage struct %s has no compatible field %s", layout.typ.String(), storageFieldPathKey(path))
	}
	indexSlot, err := b.expression(indexExpr, env)
	if err != nil {
		return -1, err
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("storage-vec struct index must lower to u64")
	}
	if err := b.guardU64Relation("lt", indexSlot, vec.lengthSlot, expr.Location); err != nil {
		return -1, err
	}
	wordIndex, err := b.storageElementWordIndex(indexSlot, layout.words, field.word, expr.Location)
	if err != nil {
		return -1, err
	}
	raw, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: raw, Args: []int{vec.idSlot, wordIndex}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return b.decodeStorageScalar(raw, field.typ, expr.Location)
}

func (b *builder) storageVecStructCopySupported(stmt hir.Statement, env *scope) bool {
	if stmt.Type == nil || stmt.Value == nil || stmt.Value.Kind != "index" || len(stmt.Value.Args) != 2 || stmt.Value.Args[0].Kind != "variable" {
		return false
	}
	vec, ok := env.lookupStorageVec(stmt.Value.Args[0].Name)
	if !ok || len(vec.typ.Args) != 1 || !hirTypeEqualForLowering(*stmt.Type, vec.typ.Args[0]) {
		return false
	}
	layout, err := storageElementLayoutFor(b.types, b.module, vec.typ.Args[0])
	return err == nil && len(layout.fields) != 0
}

func (b *builder) storageVecStructCopyLet(stmt hir.Statement, env *scope) error {
	if !b.storageVecStructCopySupported(stmt, env) {
		return fmt.Errorf("invalid storage-vec struct copy binding %s", stmt.Name)
	}
	indexExpr := *stmt.Value
	vec, _ := env.lookupStorageVec(indexExpr.Args[0].Name)
	layout, err := storageElementLayoutFor(b.types, b.module, vec.typ.Args[0])
	if err != nil {
		return err
	}
	indexSlot, err := b.expression(indexExpr.Args[1], env)
	if err != nil {
		return err
	}
	if !b.isU64Slot(indexSlot) {
		return fmt.Errorf("storage-vec struct copy index must lower to u64")
	}
	if err := b.guardU64Relation("lt", indexSlot, vec.lengthSlot, stmt.Location); err != nil {
		return err
	}
	local := fixedStructLocal{typ: *stmt.Type, fields: make(map[string]int, len(layout.fields))}
	for _, field := range layout.fields {
		wordIndex, err := b.storageElementWordIndex(indexSlot, layout.words, field.word, stmt.Location)
		if err != nil {
			return err
		}
		raw, err := b.slot(coreir.U64)
		if err != nil {
			return err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: raw, Args: []int{vec.idSlot, wordIndex}, MayTrap: true, Location: coreLocation(stmt.Location)}); err != nil {
			return err
		}
		value, err := b.decodeStorageScalar(raw, field.typ, stmt.Location)
		if err != nil {
			return err
		}
		local.fields[storageFieldPathKey(field.path)] = value
	}
	env.fixedStructs[stmt.Name] = local
	return nil
}

func (b *builder) fixedArrayIndex(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("fixed-array Core lowering requires indexing a local array variable")
	}
	baseName := expr.Args[0].Name
	array, ok := env.lookupFixedArray(baseName)
	if !ok {
		return -1, fmt.Errorf("fixed-array Core lowering cannot resolve local %s", baseName)
	}
	if len(array.typ.Args) != 1 || !hirTypeEqualForLowering(expr.Type, array.typ.Args[0]) {
		return -1, fmt.Errorf("fixed-array index result type does not match element type")
	}
	if index, constant := constantHIRU64(expr.Args[1]); constant {
		if index >= uint64(len(array.slots)) {
			return -1, fmt.Errorf("fixed-array index %d out of bounds for length %d", index, len(array.slots))
		}
		return array.slots[index], nil
	}
	return b.dynamicFixedArrayIndex(expr, env, array)
}

func (b *builder) fixedSliceIndex(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("fixed-slice Core lowering requires indexing a local slice variable")
	}
	baseName := expr.Args[0].Name
	slice, ok := env.lookupFixedSlice(baseName)
	if !ok {
		return -1, fmt.Errorf("fixed-slice Core lowering cannot resolve local %s", baseName)
	}
	if len(slice.typ.Args) != 1 || !hirTypeEqualForLowering(expr.Type, slice.typ.Args[0]) {
		return -1, fmt.Errorf("fixed-slice index result type does not match element type")
	}
	if slice.dynamic {
		indexSlot, err := b.expression(expr.Args[1], env)
		if err != nil {
			return -1, err
		}
		if !b.isU64Slot(indexSlot) {
			return -1, fmt.Errorf("dynamic fixed-slice index must lower to u64")
		}
		lengthSlot, err := b.slot(coreir.U64)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "sub", Dest: lengthSlot, Args: []int{slice.endSlot, slice.startSlot}, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
		if err := b.guardU64Relation("lt", indexSlot, lengthSlot, expr.Location); err != nil {
			return -1, err
		}
		absolute, err := b.slot(coreir.U64)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "add", Dest: absolute, Args: []int{slice.startSlot, indexSlot}, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
		return b.dynamicScalarizedIndexSlot(expr, absolute, slice.slots, "fixed-slice")
	}
	if index, constant := constantHIRU64(expr.Args[1]); constant {
		if index >= uint64(len(slice.slots)) {
			return -1, fmt.Errorf("fixed-slice index %d out of bounds for length %d", index, len(slice.slots))
		}
		return slice.slots[index], nil
	}
	return b.dynamicScalarizedIndex(expr, env, slice.slots, "fixed-slice")
}

func (b *builder) dynamicFixedArrayIndex(expr hir.Expression, env *scope, array fixedArrayLocal) (int, error) {
	return b.dynamicScalarizedIndex(expr, env, array.slots, "fixed-array")
}

func (b *builder) dynamicScalarizedIndex(expr hir.Expression, env *scope, slots []int, label string) (int, error) {
	if len(slots) == 0 {
		return -1, fmt.Errorf("dynamic index into zero-length %s is always out of bounds", label)
	}
	if len(slots) > maxScalarizedDynamicArrayLength {
		return -1, fmt.Errorf("dynamic %s scalarization supports at most %d elements, got %d", label, maxScalarizedDynamicArrayLength, len(slots))
	}
	indexSlot, err := b.expression(expr.Args[1], env)
	if err != nil {
		return -1, err
	}
	if indexSlot < 0 || indexSlot >= len(b.f.Slots) || b.f.Slots[indexSlot] != coreir.U64 {
		return -1, fmt.Errorf("dynamic %s index must lower to u64", label)
	}
	return b.dynamicScalarizedIndexSlot(expr, indexSlot, slots, label)
}

func (b *builder) dynamicScalarizedIndexSlot(expr hir.Expression, indexSlot int, slots []int, label string) (int, error) {
	if len(slots) == 0 {
		return -1, fmt.Errorf("dynamic index into zero-length %s is always out of bounds", label)
	}
	if len(slots) > maxScalarizedDynamicArrayLength {
		return -1, fmt.Errorf("dynamic %s scalarization supports at most %d elements, got %d", label, maxScalarizedDynamicArrayLength, len(slots))
	}
	if !b.isU64Slot(indexSlot) {
		return -1, fmt.Errorf("dynamic %s index must lower to u64", label)
	}
	elementType := b.f.Slots[slots[0]]
	result, err := b.slot(elementType)
	if err != nil {
		return -1, err
	}
	origin := b.current
	checkBlocks := make([]int, len(slots))
	checkBlocks[0] = origin
	for i := 1; i < len(checkBlocks); i++ {
		block, err := b.newBlock()
		if err != nil {
			return -1, err
		}
		checkBlocks[i] = block
	}
	matchBlocks := make([]int, len(slots))
	for i := range matchBlocks {
		block, err := b.newBlock()
		if err != nil {
			return -1, err
		}
		matchBlocks[i] = block
	}
	oob, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	join, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	for i := range slots {
		b.current = checkBlocks[i]
		constant, err := b.literal(hir.Expression{
			Kind: "literal", Type: hir.TypeRef{Name: "u64"}, Location: expr.Location,
			Literal: &hir.Literal{Kind: "number", Value: strconv.FormatUint(uint64(i), 10)},
		})
		if err != nil {
			return -1, err
		}
		condition, err := b.slot(coreir.Bool)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "eq", Dest: condition, Args: []int{indexSlot, constant}, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
		fallback := oob
		if i+1 < len(checkBlocks) {
			fallback = checkBlocks[i+1]
		}
		b.terminate(coreir.Terminator{Op: "branch", Value: condition, Targets: []int{matchBlocks[i], fallback}, Location: coreLocation(expr.Location)})

		b.current = matchBlocks[i]
		if err := b.move(result, slots[i], expr.Location); err != nil {
			return -1, err
		}
		b.jump(join, expr.Location)
	}
	b.current = oob
	b.terminate(coreir.Terminator{Op: "unreachable", Value: -1, Location: coreLocation(expr.Location)})
	b.current = join
	return result, nil
}

func constantHIRU64(expr hir.Expression) (uint64, bool) {
	if expr.Kind != "literal" || expr.Type.Name != "u64" || expr.Literal == nil {
		return 0, false
	}
	text := strings.ReplaceAll(expr.Literal.Value, "_", "")
	value, err := strconv.ParseUint(text, 10, 64)
	return value, err == nil
}

func hirTypeEqualForLowering(a, b hir.TypeRef) bool {
	if a.Name != b.Name || len(a.Args) != len(b.Args) || (a.Length == nil) != (b.Length == nil) {
		return false
	}
	if a.Length != nil && *a.Length != *b.Length {
		return false
	}
	for i := range a.Args {
		if !hirTypeEqualForLowering(a.Args[i], b.Args[i]) {
			return false
		}
	}
	return true
}

func (b *builder) literal(expr hir.Expression) (int, error) {
	t, err := coreType(expr.Type)
	if err != nil {
		return -1, err
	}
	if expr.Literal == nil {
		return -1, fmt.Errorf("literal payload missing")
	}
	var literal coreir.Literal
	if t == coreir.Bytes {
		literal, err = b.arena.intern(expr.Literal.Value)
	} else {
		text := expr.Literal.Value
		if t == coreir.I64 || t == coreir.U64 {
			text = strings.ReplaceAll(text, "_", "")
		}
		var value coreir.Value
		value, err = coreir.ParseValue(t, text)
		if err == nil {
			literal = value.Literal()
		}
	}
	if err != nil {
		return -1, err
	}
	dest, err := b.slot(t)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "const", Dest: dest, Constant: &literal, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return dest, nil
}

func (b *builder) call(expr hir.Expression, env *scope) (int, error) {
	if expr.Builtin == "defer_drop" {
		if len(expr.Args) != 1 || expr.Args[0].Kind != "variable" {
			return -1, fmt.Errorf("defer_drop lowering requires one local variable")
		}
		name := expr.Args[0].Name
		if _, ok := env.storageVecs[name]; !ok {
			if env.parent == nil || env.parent.parent != nil {
				return -1, fmt.Errorf("defer_drop Core lowering supports current-scope vec owners or top-level vec parameters only")
			}
			if _, ok := env.parent.storageVecs[name]; !ok {
				return -1, fmt.Errorf("defer_drop Core lowering cannot resolve storage-backed vec owner %s", name)
			}
		}
		for _, existing := range env.deferredVecDrops {
			if existing == name {
				return -1, fmt.Errorf("defer_drop already scheduled for %s", name)
			}
		}
		env.deferredVecDrops = append(env.deferredVecDrops, name)
		return -1, nil
	}
	if expr.Builtin == "vec_push" {
		return b.storageVecPush(expr, env)
	}
	if (expr.Builtin == "vec_len" || expr.Builtin == "vec_capacity") && len(expr.Args) == 1 && expr.Args[0].Kind == "variable" {
		vec, ok := env.lookupStorageVec(expr.Args[0].Name)
		if !ok {
			return -1, fmt.Errorf("%s lowering requires local storage-backed vec", expr.Builtin)
		}
		value := vec.lengthSlot
		if expr.Builtin == "vec_capacity" {
			value = vec.capacitySlot
		}
		return value, nil
	}
	if expr.Builtin == "drop" && len(expr.Args) == 1 && expr.Args[0].Kind == "variable" {
		if _, ok := env.lookupStorageRef(expr.Args[0].Name); ok {
			return -1, nil
		}
		if _, ok := env.lookupStorageSlice(expr.Args[0].Name); ok {
			return -1, nil
		}
		if _, ok := env.lookupFixedSlice(expr.Args[0].Name); ok {
			return -1, nil
		}
		if vec, ok := env.lookupStorageVec(expr.Args[0].Name); ok {
			if err := b.emit(coreir.Instruction{Op: "storage.free", Dest: -1, Args: []int{vec.idSlot}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
				return -1, err
			}
			return -1, nil
		}
		if _, ok := env.lookupFixedRef(expr.Args[0].Name); ok {
			return -1, nil
		}
	}
	if expr.Builtin == "store" {
		if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
			return -1, fmt.Errorf("store lowering requires local mutref binding and value")
		}
		if ref, ok := env.lookupStorageRef(expr.Args[0].Name); ok {
			if !ref.mutable || ref.typ.Name != "mutref" || len(ref.typ.Args) != 1 || !storageRawScalarType(ref.typ.Args[0]) {
				return -1, fmt.Errorf("storage store lowering requires mutref<u64>/mutref<i64>")
			}
			value, err := b.expression(expr.Args[1], env)
			if err != nil {
				return -1, err
			}
			raw, err := b.encodeStorageScalar(value, ref.typ.Args[0], expr.Location)
			if err != nil {
				return -1, err
			}
			if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{ref.idSlot, ref.indexSlot, raw}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
				return -1, err
			}
			return -1, nil
		}
		ref, ok := env.lookupFixedRef(expr.Args[0].Name)
		if !ok || !ref.mutable || ref.typ.Name != "mutref" || len(ref.typ.Args) != 1 {
			return -1, fmt.Errorf("store lowering requires local mutref binding")
		}
		value, err := b.expression(expr.Args[1], env)
		if err != nil {
			return -1, err
		}
		if ref.targetSlot < 0 || ref.targetSlot >= len(b.f.Slots) || value < 0 || value >= len(b.f.Slots) || b.f.Slots[ref.targetSlot] != b.f.Slots[value] {
			return -1, fmt.Errorf("store lowering type mismatch")
		}
		if err := b.move(ref.targetSlot, value, expr.Location); err != nil {
			return -1, err
		}
		return -1, nil
	}
	if expr.Callee != nil {
		decl, ok := b.functions[expr.Callee.Canonical()]
		if !ok || decl.Function == nil {
			return -1, fmt.Errorf("missing HIR callee signature %s", expr.Callee.Canonical())
		}
		if len(decl.Function.Params) != len(expr.Args) {
			return -1, fmt.Errorf("callee %s argument count changed during lowering", expr.Callee.Canonical())
		}
		args := make([]int, 0, len(expr.Args)+2)
		for i, arg := range expr.Args {
			param := decl.Function.Params[i]
			if storageVecType(b.types, decl.ID.Module, param.Type) {
				if arg.Kind != "variable" {
					return -1, fmt.Errorf("storage vec call argument %d to %s must be a local descriptor binding", i, expr.Callee.Canonical())
				}
				vec, ok := env.lookupStorageVec(arg.Name)
				if !ok {
					return -1, fmt.Errorf("storage vec call argument %s is not storage-backed", arg.Name)
				}
				args = append(args, vec.idSlot, vec.lengthSlot, vec.capacitySlot)
				continue
			}
			slot, err := b.expression(arg, env)
			if err != nil {
				return -1, err
			}
			args = append(args, slot)
		}
		vecResult := storageVecType(b.types, b.module, expr.Type)
		result := coreir.U64
		var err error
		if !vecResult {
			result, err = coreType(expr.Type)
			if err != nil {
				return -1, err
			}
		}
		callee, ok := b.symbols[expr.Callee.Canonical()]
		if !ok {
			return -1, fmt.Errorf("missing lowered symbol %s", expr.Callee.Canonical())
		}
		dest := -1
		if result != coreir.Void {
			dest, err = b.slot(result)
			if err != nil {
				return -1, err
			}
		}
		if err := b.emit(coreir.Instruction{Op: "call", Dest: dest, Args: args, Callee: callee, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
		return dest, nil
	}
	args := make([]int, len(expr.Args))
	for i, arg := range expr.Args {
		slot, err := b.expression(arg, env)
		if err != nil {
			return -1, err
		}
		args[i] = slot
	}
	result, err := coreType(expr.Type)
	if err != nil {
		return -1, err
	}
	return b.builtin(expr, args, result)
}

func (b *builder) emitDeferredVecDrops(env *scope, loc hir.Location) error {
	for i := len(env.deferredVecDrops) - 1; i >= 0; i-- {
		name := env.deferredVecDrops[i]
		vec, ok := env.lookupStorageVec(name)
		if !ok {
			return fmt.Errorf("deferred vec cleanup lost local %s", name)
		}
		if err := b.emit(coreir.Instruction{Op: "storage.free", Dest: -1, Args: []int{vec.idSlot}, MayTrap: true, Location: coreLocation(loc)}); err != nil {
			return err
		}
	}
	return nil
}

func (b *builder) emitAllDeferredVecDrops(env *scope, loc hir.Location) error {
	for cur := env; cur != nil; cur = cur.parent {
		if err := b.emitDeferredVecDrops(cur, loc); err != nil {
			return err
		}
	}
	return nil
}

func (b *builder) storageVecPush(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 || expr.Args[0].Kind != "variable" {
		return -1, fmt.Errorf("vec_push lowering requires local vec variable and value")
	}
	vec, ok := env.lookupStorageVec(expr.Args[0].Name)
	if !ok || len(vec.typ.Args) != 1 {
		return -1, fmt.Errorf("vec_push lowering requires a local storage-backed vec")
	}
	layout, err := storageElementLayoutFor(b.types, b.module, vec.typ.Args[0])
	if err != nil {
		return -1, err
	}
	rawValues, err := b.encodeStorageElement(expr.Args[1], layout, env)
	if err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("le", vec.lengthSlot, vec.capacitySlot, expr.Location); err != nil {
		return -1, err
	}
	hasCapacity, err := b.slot(coreir.Bool)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "lt", Dest: hasCapacity, Args: []int{vec.lengthSlot, vec.capacitySlot}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	one, err := b.u64Constant(1, expr.Location)
	if err != nil {
		return -1, err
	}
	origin := b.current
	inPlace, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	grow, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	join, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	b.current = origin
	b.terminate(coreir.Terminator{Op: "branch", Value: hasCapacity, Targets: []int{inPlace, grow}, Location: coreLocation(expr.Location)})

	// Fast path: existing allocation has room.
	b.current = inPlace
	for word, rawValue := range rawValues {
		wordIndex, err := b.storageElementWordIndex(vec.lengthSlot, layout.words, uint64(word), expr.Location)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{vec.idSlot, wordIndex, rawValue}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
	}
	nextLength, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: nextLength, Args: []int{vec.lengthSlot, one}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.move(vec.lengthSlot, nextLength, expr.Location); err != nil {
		return -1, err
	}
	b.jump(join, expr.Location)

	// Slow path: derive the next capacity at runtime, preserving overflow safety.
	b.current = grow
	zero, err := b.u64Constant(0, expr.Location)
	if err != nil {
		return -1, err
	}
	isZero, err := b.slot(coreir.Bool)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "eq", Dest: isZero, Args: []int{vec.capacitySlot, zero}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	capacityZero, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	capacityDouble, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	capacityReady, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	b.current = grow
	b.terminate(coreir.Terminator{Op: "branch", Value: isZero, Targets: []int{capacityZero, capacityDouble}, Location: coreLocation(expr.Location)})
	newCapacity, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	b.current = capacityZero
	if err := b.move(newCapacity, one, expr.Location); err != nil {
		return -1, err
	}
	b.jump(capacityReady, expr.Location)

	b.current = capacityDouble
	maxHalf, err := b.u64Constant(^uint64(0)/2, expr.Location)
	if err != nil {
		return -1, err
	}
	if err := b.guardU64Relation("le", vec.capacitySlot, maxHalf, expr.Location); err != nil {
		return -1, err
	}
	doubled, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: doubled, Args: []int{vec.capacitySlot, vec.capacitySlot}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.move(newCapacity, doubled, expr.Location); err != nil {
		return -1, err
	}
	b.jump(capacityReady, expr.Location)

	b.current = capacityReady
	allocationWords, err := b.scaleStorageCount(newCapacity, layout.words, expr.Location)
	if err != nil {
		return -1, err
	}
	newID, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.alloc_u64", Dest: newID, Args: []int{allocationWords}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	copyIndex, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.move(copyIndex, zero, expr.Location); err != nil {
		return -1, err
	}
	copyLimit, err := b.scaleStorageCount(vec.lengthSlot, layout.words, expr.Location)
	if err != nil {
		return -1, err
	}
	copyPreheader := b.current
	copyHead, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	copyBody, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	copyDone, err := b.newBlock()
	if err != nil {
		return -1, err
	}
	b.current = copyPreheader
	b.jump(copyHead, expr.Location)
	b.current = copyHead
	copyMore, err := b.slot(coreir.Bool)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "lt", Dest: copyMore, Args: []int{copyIndex, copyLimit}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	b.terminate(coreir.Terminator{Op: "branch", Value: copyMore, Targets: []int{copyBody, copyDone}, Location: coreLocation(expr.Location)})

	b.current = copyBody
	item, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.load_u64", Dest: item, Args: []int{vec.idSlot, copyIndex}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{newID, copyIndex, item}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	nextCopy, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: nextCopy, Args: []int{copyIndex, one}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.move(copyIndex, nextCopy, expr.Location); err != nil {
		return -1, err
	}
	b.jump(copyHead, expr.Location)

	b.current = copyDone
	for word, rawValue := range rawValues {
		wordIndex, err := b.storageElementWordIndex(vec.lengthSlot, layout.words, uint64(word), expr.Location)
		if err != nil {
			return -1, err
		}
		if err := b.emit(coreir.Instruction{Op: "storage.store_u64", Dest: -1, Args: []int{newID, wordIndex, rawValue}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
			return -1, err
		}
	}
	if err := b.emit(coreir.Instruction{Op: "storage.free", Dest: -1, Args: []int{vec.idSlot}, MayTrap: true, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.move(vec.idSlot, newID, expr.Location); err != nil {
		return -1, err
	}
	if err := b.move(vec.capacitySlot, newCapacity, expr.Location); err != nil {
		return -1, err
	}
	grownLength, err := b.slot(coreir.U64)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: "add", Dest: grownLength, Args: []int{vec.lengthSlot, one}, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	if err := b.move(vec.lengthSlot, grownLength, expr.Location); err != nil {
		return -1, err
	}
	b.jump(join, expr.Location)
	b.current = join
	return -1, nil
}

func (b *builder) builtin(expr hir.Expression, args []int, result coreir.Type) (int, error) {
	op, effect, capability, trap := "", "", "", false
	switch expr.Builtin {
	case "print":
		op, effect, capability, trap = "io.stdout", coreir.EffectIOStdout, "stdout_write", true
	case "eprint":
		op, effect, capability, trap = "io.stderr", coreir.EffectIOStderr, "stderr_write", true
	case "clock":
		op, effect, capability, trap = "clock.read", coreir.EffectClockRead, "clock_read", true
	case "random":
		op, effect, capability, trap = "rng.sample", coreir.EffectRNGSample, "rng_sample", true
	case "write_file":
		op, effect, capability, trap = "fs.write", coreir.EffectFSWrite, "workspace_write", true
	case "read_file":
		op, effect, capability, trap = "fs.read", coreir.EffectFSRead, "workspace_read", true
	case "tcp_connect":
		op, effect, capability, trap = "net.connect", coreir.EffectNetConnect, "network_connect", true
	case "http_fetch":
		op, effect, capability, trap = "net.fetch", coreir.EffectNetFetch, "network_fetch", true
	case "process_exec":
		op, effect, capability, trap = "process.exec", coreir.EffectProcessExec, "process_exec", true
	case "bytes_len":
		op = "bytes.len"
	case "bytes_get":
		op, trap = "bytes.get", true
	default:
		return -1, fmt.Errorf("unsupported Core builtin %q", expr.Builtin)
	}
	if effect != "" {
		b.addEffect(effect, capability)
	}
	dest := -1
	if result != coreir.Void {
		var err error
		dest, err = b.slot(result)
		if err != nil {
			return -1, err
		}
	}
	if err := b.emit(coreir.Instruction{Op: op, Dest: dest, Args: args, MayTrap: trap, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return dest, nil
}

func (b *builder) unary(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 1 {
		return -1, fmt.Errorf("invalid unary expression")
	}
	t, err := coreType(expr.Type)
	if err != nil {
		return -1, err
	}
	if expr.Operator == "-" && t == coreir.I64 && expr.Args[0].Kind == "literal" && expr.Args[0].Literal != nil {
		text := strings.ReplaceAll(expr.Args[0].Literal.Value, "_", "")
		value, parseErr := coreir.ParseValue(coreir.I64, "-"+text)
		if parseErr == nil {
			dest, err := b.slot(coreir.I64)
			if err != nil {
				return -1, err
			}
			literal := value.Literal()
			if err := b.emit(coreir.Instruction{Op: "const", Dest: dest, Constant: &literal, Location: coreLocation(expr.Location)}); err != nil {
				return -1, err
			}
			return dest, nil
		}
	}
	arg, err := b.expression(expr.Args[0], env)
	if err != nil {
		return -1, err
	}
	op := "neg"
	trap := t == coreir.I64
	if expr.Operator == "!" {
		op, trap = "not", false
	}
	dest, err := b.slot(t)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{arg}, MayTrap: trap, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return dest, nil
}

func (b *builder) binary(expr hir.Expression, env *scope) (int, error) {
	if len(expr.Args) != 2 {
		return -1, fmt.Errorf("invalid binary expression")
	}
	if expr.Operator == "&&" || expr.Operator == "||" {
		left, err := b.expression(expr.Args[0], env)
		if err != nil {
			return -1, err
		}
		origin := b.current
		dest, err := b.slot(coreir.Bool)
		if err != nil {
			return -1, err
		}
		rhs, err := b.newBlock()
		if err != nil {
			return -1, err
		}
		short, err := b.newBlock()
		if err != nil {
			return -1, err
		}
		join, err := b.newBlock()
		if err != nil {
			return -1, err
		}
		b.current = origin
		targets := []int{rhs, short}
		if expr.Operator == "||" {
			targets = []int{short, rhs}
		}
		b.terminate(coreir.Terminator{Op: "branch", Value: left, Targets: targets, Location: coreLocation(expr.Location)})
		b.current = short
		if err := b.move(dest, left, expr.Location); err != nil {
			return -1, err
		}
		b.jump(join, expr.Location)
		b.current = rhs
		right, err := b.expression(expr.Args[1], env)
		if err != nil {
			return -1, err
		}
		if err := b.move(dest, right, expr.Location); err != nil {
			return -1, err
		}
		b.jump(join, expr.Location)
		b.current = join
		return dest, nil
	}
	left, err := b.expression(expr.Args[0], env)
	if err != nil {
		return -1, err
	}
	right, err := b.expression(expr.Args[1], env)
	if err != nil {
		return -1, err
	}
	ops := map[string]string{
		"+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem",
		"&": "band", "|": "bor", "^": "bxor", "<<": "shl", ">>": "shr",
		"==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
	}
	op := ops[expr.Operator]
	if op == "" {
		return -1, fmt.Errorf("unsupported binary operator %s", expr.Operator)
	}
	operandType := b.f.Slots[left]
	result, err := coreType(expr.Type)
	if err != nil {
		return -1, err
	}
	trap := operandType != coreir.IEEE64
	if op == "eq" || op == "ne" || op == "lt" || op == "le" || op == "gt" || op == "ge" {
		trap = false
	} else if operandType == coreir.U64 {
		switch op {
		case "add", "sub", "mul", "band", "bor", "bxor":
			trap = false
		case "div", "rem", "shl", "shr":
			trap = true
		}
	}
	dest, err := b.slot(result)
	if err != nil {
		return -1, err
	}
	if err := b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{left, right}, MayTrap: trap, Location: coreLocation(expr.Location)}); err != nil {
		return -1, err
	}
	return dest, nil
}

func (b *builder) addEffect(effect, capability string) {
	b.f.EffectVersion = coreir.EffectVersion
	b.f.Effects = append(b.f.Effects, effect)
	b.f.RequiredCapabilities = append(b.f.RequiredCapabilities, coreir.CapabilityRequirement{Name: capability, Effect: effect})
}

func canonicalizeEffects(f *coreir.Function) {
	effects := map[string]bool{}
	for _, effect := range f.Effects {
		effects[effect] = true
	}
	f.Effects = f.Effects[:0]
	for effect := range effects {
		f.Effects = append(f.Effects, effect)
	}
	sort.Strings(f.Effects)
	caps := map[coreir.CapabilityRequirement]bool{}
	for _, cap := range f.RequiredCapabilities {
		caps[cap] = true
	}
	f.RequiredCapabilities = f.RequiredCapabilities[:0]
	for cap := range caps {
		f.RequiredCapabilities = append(f.RequiredCapabilities, cap)
	}
	sort.Slice(f.RequiredCapabilities, func(i, j int) bool {
		a, b := f.RequiredCapabilities[i], f.RequiredCapabilities[j]
		if a.Effect != b.Effect {
			return a.Effect < b.Effect
		}
		return a.Name < b.Name
	})
	if len(f.Effects) == 0 {
		f.EffectVersion = 0
	}
}

func propagateEffects(module *coreir.Module) {
	byName := map[string]int{}
	for i := range module.Functions {
		byName[module.Functions[i].Name] = i
	}
	for round := 0; round <= len(module.Functions); round++ {
		changed := false
		for i := range module.Functions {
			f := &module.Functions[i]
			effects := map[string]bool{}
			caps := map[coreir.CapabilityRequirement]bool{}
			for _, effect := range f.Effects {
				effects[effect] = true
			}
			for _, cap := range f.RequiredCapabilities {
				caps[cap] = true
			}
			for _, block := range f.Blocks {
				for _, ins := range block.Instructions {
					if ins.Op != "call" {
						continue
					}
					ci, ok := byName[ins.Callee]
					if !ok {
						continue
					}
					callee := module.Functions[ci]
					for _, effect := range callee.Effects {
						if !effects[effect] {
							effects[effect], changed = true, true
						}
					}
					for _, cap := range callee.RequiredCapabilities {
						if !caps[cap] {
							caps[cap], changed = true, true
						}
					}
				}
			}
			f.Effects = f.Effects[:0]
			for effect := range effects {
				f.Effects = append(f.Effects, effect)
			}
			sort.Strings(f.Effects)
			f.RequiredCapabilities = f.RequiredCapabilities[:0]
			for cap := range caps {
				f.RequiredCapabilities = append(f.RequiredCapabilities, cap)
			}
			sort.Slice(f.RequiredCapabilities, func(i, j int) bool {
				a, b := f.RequiredCapabilities[i], f.RequiredCapabilities[j]
				if a.Effect != b.Effect {
					return a.Effect < b.Effect
				}
				return a.Name < b.Name
			})
			if len(f.Effects) > 0 {
				f.EffectVersion = coreir.EffectVersion
			} else {
				f.EffectVersion = 0
			}
		}
		if !changed {
			break
		}
	}
}

func coreLocation(loc hir.Location) coreir.Location {
	return coreir.Location{File: loc.File, Line: loc.Line, Column: loc.Column}
}
