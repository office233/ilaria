package coreir

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func snapshotProcessSSA(t *testing.T, m Module, arm bool, registers int) ([]SSAFunction, map[string]SSARegisterPlan) {
	t.Helper()
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	functions := make([]SSAFunction, len(m.Functions))
	plans := make(map[string]SSARegisterPlan, len(m.Functions))
	if registers == 0 {
		registers = X64LeafRegisterCount()
		if arm {
			registers = ARM64MachineRegisterCount()
		}
	}
	for i, f := range m.Functions {
		ssa, err := BuildSSA(f)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := AllocateSSARegisters(ssa, registers, 0)
		if err != nil {
			t.Fatal(err)
		}
		functions[i], plans[f.Name] = ssa, plan
	}
	return functions, plans
}

func snapshotProcessImage(t *testing.T, m Module, target string, pie bool, ioBytes, registers int) []byte {
	t.Helper()
	arm := target == "arm64"
	functions, plans := snapshotProcessSSA(t, m, arm, registers)
	if arm {
		process, err := EmitARM64CFGMachineProcessModule(functions, plans, "entry")
		if err != nil {
			t.Fatal(err)
		}
		process.Data = m.Data
		process.StorageDataBytes = DefaultNativeStorageArenaBytes
		process.RuntimeDataBytes = ioBytes + process.StorageDataBytes
		image, err := EncodeARM64ELFProcessExecutable(functions[0], process, pie)
		if err != nil {
			t.Fatal(err)
		}
		return image
	}
	process, err := EmitX64CFGMachineProcessModule(functions, plans, "entry")
	if err != nil {
		t.Fatal(err)
	}
	process.Data = m.Data
	process.StorageDataBytes = DefaultNativeStorageArenaBytes
	process.RuntimeDataBytes = ioBytes + process.StorageDataBytes
	var image []byte
	if target == "pe" {
		image, err = EncodeX64PEProcessExecutable(functions[0], process)
	} else {
		image, err = EncodeX64ELFProcessExecutable(functions[0], process, pie)
	}
	if err != nil {
		t.Fatal(err)
	}
	return image
}

func runSnapshotProcess(t *testing.T, image []byte, target string, args []string, files map[string][]byte, wantExit int, outputs map[string][]byte) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.exe")
	if err := os.WriteFile(path, image, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if target == "arm64" {
		qemu := os.Getenv("SWYP_QEMU_AARCH64")
		if qemu == "" {
			t.Skip("SWYP_QEMU_AARCH64 not supplied")
		}
		cmd = exec.CommandContext(ctx, qemu, append([]string{path}, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, path, args...)
	}
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("native snapshot timeout: %v output=%q", ctx.Err(), out)
	}
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			t.Fatalf("execute: %v output=%q", err, out)
		}
	}
	if exit != wantExit {
		t.Fatalf("args=%v exit=%d want=%d output=%q", args, exit, wantExit, out)
	}
	for name, want := range outputs {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("file=%s got=%v want=%v err=%v", name, got, want, err)
		}
	}
}

func snapshotCalledFixture() Module {
	m := snapshotScalarFixture(false)
	f := &m.Functions[0]
	ops := f.Blocks[0].Instructions
	f.Blocks[0].Instructions = append(ops[:len(ops)-1],
		Instruction{Op: "call", Dest: 5, Args: []int{5}, Callee: "identity", MayTrap: true},
		Instruction{Op: "call", Dest: 8, Args: []int{5, 4}, Callee: "read", MayTrap: true})
	m.Functions = append(m.Functions,
		Function{Name: "identity", Params: []Parameter{{Name: "span", Type: Bytes}}, Result: Bytes, Slots: []Type{Bytes},
			Blocks: []Block{{Terminator: Terminator{Op: "return", Value: 0}}}},
		Function{Name: "read", Params: []Parameter{{Name: "span", Type: Bytes}, {Name: "index", Type: U64}}, Result: U64, Slots: []Type{Bytes, U64, U64},
			Blocks: []Block{{Instructions: []Instruction{{Op: "bytes.get", Dest: 2, Args: []int{0, 1}, MayTrap: true}},
				Terminator: Terminator{Op: "return", Value: 2}}}})
	return m
}

func snapshotWriteFixture(readFirst bool) Module {
	m := snapshotFixture()
	m.Data = []byte("first.binsecond.bininput.binread.bin")
	f := &m.Functions[0]
	f.Result, f.EffectVersion, f.Effects = U64, EffectVersion, []string{EffectClockRead, EffectFSWrite}
	f.RequiredCapabilities = []CapabilityRequirement{{Name: "clock_read", Effect: EffectClockRead}, {Name: "workspace_write", Effect: EffectFSWrite}}
	f.Slots = append(f.Slots, Bytes, Bytes, Bytes, Bytes, U64)
	path := func(dest int, offset, length uint32) Instruction {
		span, err := ByteSpan(offset, length)
		if err != nil {
			panic(err)
		}
		lit := span.Literal()
		return Instruction{Op: "const", Dest: dest, Constant: &lit}
	}
	ops := f.Blocks[0].Instructions
	if readFirst {
		f.Effects = []string{EffectClockRead, EffectFSRead, EffectFSWrite}
		f.RequiredCapabilities = []CapabilityRequirement{{Name: "clock_read", Effect: EffectClockRead}, {Name: "workspace_read", Effect: EffectFSRead}, {Name: "workspace_write", Effect: EffectFSWrite}}
		f.Blocks[0].Instructions = append([]Instruction{
			path(11, 19, 9),
			{Op: EffectFSRead, Dest: 12, Args: []int{11}, MayTrap: true},
		}, ops...)
	}
	f.Blocks[0].Instructions = append(f.Blocks[0].Instructions,
		path(9, 0, 9), path(10, 9, 10),
		Instruction{Op: EffectClockRead, Dest: 13, MayTrap: true},
		Instruction{Op: EffectFSWrite, Dest: -1, Args: []int{9, 5}, MayTrap: true},
		Instruction{Op: EffectClockRead, Dest: 13, MayTrap: true},
		Instruction{Op: EffectFSWrite, Dest: -1, Args: []int{10, 7}, MayTrap: true},
		Instruction{Op: EffectClockRead, Dest: 13, MayTrap: true})
	if readFirst {
		f.Blocks[0].Instructions = append(f.Blocks[0].Instructions,
			path(11, 28, 8),
			Instruction{Op: EffectFSWrite, Dest: -1, Args: []int{11, 12}, MayTrap: true})
	}
	f.Blocks[0].Instructions = append(f.Blocks[0].Instructions, snapshotConst(8, 0))
	f.Blocks[0].Terminator.Value = 8
	return m
}

func snapshotNativeTargets(t *testing.T) []string {
	t.Helper()
	targets := []string{}
	if runtime.GOARCH == "amd64" {
		if runtime.GOOS == "windows" {
			targets = append(targets, "pe")
		} else if runtime.GOOS == "linux" {
			targets = append(targets, "elf")
		}
	}
	if runtime.GOOS == "linux" && os.Getenv("SWYP_QEMU_AARCH64") != "" {
		targets = append(targets, "arm64")
	}
	if len(targets) == 0 {
		t.Skip("standalone native execution unavailable")
	}
	return targets
}

func TestBytesSnapshotStandaloneNativeParity(t *testing.T) {
	for _, target := range snapshotNativeTargets(t) {
		for _, pie := range []bool{false, true} {
			if target == "pe" && pie {
				continue
			}
			t.Run(target+"-pie"+strconv.FormatBool(pie), func(t *testing.T) {
				image := snapshotProcessImage(t, snapshotScalarFixture(false), target, pie, DefaultProcessRuntimeArenaBytes, 0)
				for _, tc := range []struct {
					args []string
					exit int
				}{
					{[]string{"3", "2", "65"}, 65},
					{[]string{"3", "2", "255"}, 255},
					{[]string{"2", "2", "256"}, 1},
					{[]string{"2", "2", "18446744073709551615"}, 1},
					{[]string{"2", "3", "65"}, 1},
					{[]string{"2", "18446744073709551615", "65"}, 1},
					{[]string{"40000", "40000", "65"}, 1},
				} {
					runSnapshotProcess(t, image, target, tc.args, nil, tc.exit, nil)
				}
				empty := snapshotProcessImage(t, snapshotScalarFixture(true), target, pie, 8, 0)
				runSnapshotProcess(t, empty, target, []string{"1", "0", "256"}, nil, 0, nil)
				small := snapshotProcessImage(t, snapshotScalarFixture(false), target, pie, 12, 1)
				runSnapshotProcess(t, small, target, []string{"2", "2", "65"}, nil, 65, nil)
				runSnapshotProcess(t, small, target, []string{"3", "3", "65"}, nil, 1, nil)
				calls := snapshotProcessImage(t, snapshotCalledFixture(), target, pie, DefaultProcessRuntimeArenaBytes, 1)
				runSnapshotProcess(t, calls, target, []string{"2", "2", "65"}, nil, 65, nil)
				freed := snapshotProcessImage(t, snapshotFreedFixture(), target, pie, 8, 1)
				runSnapshotProcess(t, freed, target, []string{"1", "0", "65"}, nil, 1, nil)
				zero := snapshotProcessImage(t, snapshotZeroCapacityFixture(), target, pie, 8, 1)
				runSnapshotProcess(t, zero, target, []string{"0", "0", "256"}, nil, 0, nil)
				wrap := snapshotProcessImage(t, snapshotWrapFixture(), target, pie, 16, 1)
				runSnapshotProcess(t, wrap, target, []string{"1", "1", "18446744073709551615"}, nil, 0, nil)
			})
		}
	}
}

func TestBytesSnapshotStandaloneFSWrite(t *testing.T) {
	for _, target := range snapshotNativeTargets(t) {
		for _, readFirst := range []bool{false, true} {
			t.Run(target+"-read"+strconv.FormatBool(readFirst), func(t *testing.T) {
				image := snapshotProcessImage(t, snapshotWriteFixture(readFirst), target, target != "pe", DefaultProcessRuntimeArenaBytes, 1)
				outputs := map[string][]byte{"first.bin": {65, 0}, "second.bin": {90, 0}}
				if readFirst {
					outputs["read.bin"] = []byte{0, 255, 7}
				}
				runSnapshotProcess(t, image, target, []string{"2", "2", "65"}, map[string][]byte{"input.bin": {0, 255, 7}}, 0, outputs)
			})
		}
	}
}

func TestBytesSnapshotNativeRefusesPackedAndMissingArenas(t *testing.T) {
	m := snapshotScalarFixture(false)
	for _, arm := range []bool{false, true} {
		functions, plans := snapshotProcessSSA(t, m, arm, 0)
		var err error
		if arm {
			_, err = EmitARM64CFGMachineModule(functions, plans, "entry")
		} else {
			_, err = EmitX64CFGMachineModule(functions, plans, "entry")
		}
		if err == nil {
			t.Fatalf("arm=%v packed snapshot unexpectedly accepted", arm)
		}
	}
	for _, sizes := range [][3]int{{0, 0, 512 << 10}, {0, 64 << 10, 0}, {0, 64 << 10, MaxProcessRuntimeArenaBytes}} {
		if _, _, err := buildX64BytesFromStorageHelper(sizes[0], sizes[1], sizes[2]); err == nil {
			t.Fatalf("x64 invalid arenas accepted: %v", sizes)
		}
		if _, _, err := buildARM64BytesFromStorageHelper(sizes[0], sizes[1], sizes[2]); err == nil {
			t.Fatalf("arm64 invalid arenas accepted: %v", sizes)
		}
	}
}

// Unlike Core guest instructions, this test wrapper can inspect a failed
// helper's status and then continue, proving its cursor was not published.
func snapshotAtomicHelperImage(t *testing.T, target string) []byte {
	t.Helper()
	const moduleLen = 8
	entry := SSAFunction{Name: "entry", Result: U64}
	if target != "arm64" {
		b := &x64MachineBuilder{}
		b.push(x64RBP)
		b.movRegReg(x64RBP, x64RCX) // caller's status pointer
		b.subRegImm32(x64RSP, 32)
		var calls []X64ProcessRuntimeFixup
		var failures []int
		call := func(helper string, args ...uint64) {
			for i, arg := range args {
				b.movRegImm64(x64WinArgRegs[i], arg)
			}
			calls = append(calls, X64ProcessRuntimeFixup{DispPos: b.callRel32(), Helper: "__swyp_rt_" + helper})
		}
		expect := func(reg int, value uint64) {
			b.movRegImm64(x64R8, value)
			b.cmpRegReg(reg, x64R8)
			failures = append(failures, b.jccRel32(0x5))
		}
		call("storage_alloc_u64", 3)
		expect(x64RAX, 1)
		call("storage_store_u64", 1, 0, 65)
		call("storage_store_u64", 1, 2, 256)
		call("bytes_from_storage_u64", 1, 3)
		expect(x64RDX, 1)
		call("bytes_from_storage_u64", 1, 0)
		expect(x64RDX, 0)
		expect(x64RAX, moduleLen<<32)
		call("bytes_get", moduleLen<<32|1, 0)
		expect(x64RDX, 1) // uncommitted payload cannot be read
		call("storage_store_u64", 1, 2, 255)
		call("bytes_from_storage_u64", 1, 3)
		expect(x64RDX, 0)
		expect(x64RAX, moduleLen<<32|3)
		call("bytes_from_storage_u64", 1, 1)
		expect(x64RDX, 0)
		expect(x64RAX, (moduleLen+3)<<32|1)
		call("bytes_from_storage_u64", 1, 1)
		expect(x64RDX, 1)
		call("bytes_from_storage_u64", 1, 0)
		expect(x64RAX, (moduleLen+4)<<32)
		call("bytes_get", moduleLen<<32|3, 2)
		expect(x64RDX, 0)
		expect(x64RAX, 255)
		call("storage_load_u64", 1, 2)
		expect(x64RAX, 255)
		b.xorRegReg(x64RAX, x64RAX)
		b.movMemDisp32Reg(x64RBP, 0, x64RAX)
		b.addRegImm32(x64RSP, 32)
		b.pop(x64RBP)
		b.ret()
		for _, pos := range failures {
			patchX64Rel32(b.code, pos, len(b.code))
		}
		b.movRegImm64(x64RAX, 1)
		b.movMemDisp32Reg(x64RBP, 0, x64RAX)
		b.addRegImm32(x64RSP, 32)
		b.pop(x64RBP)
		b.ret()
		process := X64ProcessMachineCode{Code: b.code, RuntimeFixups: calls, Data: []byte("constant"),
			RuntimeDataBytes: 12 + DefaultNativeStorageArenaBytes, StorageDataBytes: DefaultNativeStorageArenaBytes}
		var image []byte
		var err error
		if target == "pe" {
			image, err = EncodeX64PEProcessExecutable(entry, process)
		} else {
			image, err = EncodeX64ELFProcessExecutable(entry, process, true)
		}
		if err != nil {
			t.Fatal(err)
		}
		return image
	}
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-32); err != nil {
		t.Fatal(err)
	}
	if err := b.strRegSP(19, 0); err != nil {
		t.Fatal(err)
	}
	if err := b.strRegSP(30, 8); err != nil {
		t.Fatal(err)
	}
	b.movRegReg(19, 0)
	var calls []ARM64ProcessRuntimeFixup
	var failures []int
	call := func(helper string, args ...uint64) {
		for i, arg := range args {
			b.movImm64(i, arg)
		}
		calls = append(calls, ARM64ProcessRuntimeFixup{WordIndex: b.blPlaceholder(), Helper: "__swyp_rt_" + helper})
	}
	expect := func(reg int, value uint64) {
		b.movImm64(17, value)
		b.cmpRegReg(reg, 17)
		failures = append(failures, b.condBranchPlaceholder(0x1))
	}
	call("storage_alloc_u64", 3)
	expect(0, 1)
	call("storage_store_u64", 1, 0, 65)
	call("storage_store_u64", 1, 2, 256)
	call("bytes_from_storage_u64", 1, 3)
	expect(1, 1)
	call("bytes_from_storage_u64", 1, 0)
	expect(1, 0)
	expect(0, moduleLen<<32)
	call("bytes_get", moduleLen<<32|1, 0)
	expect(1, 1)
	call("storage_store_u64", 1, 2, 255)
	call("bytes_from_storage_u64", 1, 3)
	expect(1, 0)
	expect(0, moduleLen<<32|3)
	call("bytes_from_storage_u64", 1, 1)
	expect(1, 0)
	expect(0, (moduleLen+3)<<32|1)
	call("bytes_from_storage_u64", 1, 1)
	expect(1, 1)
	call("bytes_from_storage_u64", 1, 0)
	expect(0, (moduleLen+4)<<32)
	call("bytes_get", moduleLen<<32|3, 2)
	expect(1, 0)
	expect(0, 255)
	call("storage_load_u64", 1, 2)
	expect(0, 255)
	epilogue := func(status uint64) {
		b.movImm64(0, status)
		b.strReg(19, 0)
		if err := b.ldrRegSP(19, 0); err != nil {
			t.Fatal(err)
		}
		if err := b.ldrRegSP(30, 8); err != nil {
			t.Fatal(err)
		}
		if err := b.adjustSP(32); err != nil {
			t.Fatal(err)
		}
		b.ret()
	}
	epilogue(0)
	for _, pos := range failures {
		if err := b.patchCondBranch(pos, len(b.words)); err != nil {
			t.Fatal(err)
		}
	}
	epilogue(1)
	code := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(code[i*4:], word)
	}
	process := ARM64ProcessMachineCode{Code: code, RuntimeFixups: calls, Data: []byte("constant"),
		RuntimeDataBytes: 12 + DefaultNativeStorageArenaBytes, StorageDataBytes: DefaultNativeStorageArenaBytes}
	image, err := EncodeARM64ELFProcessExecutable(entry, process, true)
	if err != nil {
		t.Fatal(err)
	}
	return image
}

func TestBytesSnapshotStandaloneAtomicHelperCommit(t *testing.T) {
	for _, target := range snapshotNativeTargets(t) {
		t.Run(target, func(t *testing.T) {
			runSnapshotProcess(t, snapshotAtomicHelperImage(t, target), target, nil, nil, 0, nil)
		})
	}
}
