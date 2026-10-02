package coreir

import (
	"encoding/binary"
	"fmt"
)

func validateNativeSnapshotArenas(moduleLen, ioBytes, storageBytes int) error {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || ioBytes < 8 ||
		storageBytes < nativeStoragePayloadOffset || ioBytes > MaxProcessRuntimeArenaBytes-storageBytes {
		return fmt.Errorf("bytes.from_storage_u64: invalid module/IO/storage arenas %d/%d/%d", moduleLen, ioBytes, storageBytes)
	}
	return nil
}

// RAX=descriptor, R10=module base; returns R10=data pointer, RAX=length.
// Runtime offsets must lie entirely inside the committed payload, not storage
// or uncommitted spare capacity. The caller patches all failures before I/O.
func (b *x64MachineBuilder) emitFSWriteDataPointer(moduleLen, runtimeBytes int) ([]x64ProcessDataFixup, []int) {
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	runtime := b.jccRel32(0x3)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	fail := []int{b.jccRel32(0x7)}
	b.binaryRegReg(0x01, x64R10, x64R8)
	resolved := b.jmpRel32()
	patchX64Rel32(b.code, runtime, len(b.code))
	var fixups []x64ProcessDataFixup
	if runtimeBytes >= 8 {
		fixups = append(fixups, x64ProcessDataFixup{DispPos: b.leaRegRIPRel32(x64R10), Target: processDataRuntime})
		b.subRegImm32(x64R8, uint32(moduleLen))
		b.movRegMemDisp32(x64R9, x64R10, 0)
		b.cmpRegImm32(x64R9, uint32(runtimeBytes-8))
		fail = append(fail, b.jccRel32(0x7))
		b.cmpRegReg(x64R8, x64R9)
		fail = append(fail, b.jccRel32(0x7))
		b.binaryRegReg(0x29, x64R9, x64R8)
		b.cmpRegReg(x64RAX, x64R9)
		fail = append(fail, b.jccRel32(0x7))
		b.addRegImm8(x64R10, 8)
		b.binaryRegReg(0x01, x64R10, x64R8)
	} else {
		b.testRegReg(x64RAX, x64RAX)
		fail = append(fail, b.jccRel32(0x5))
		b.cmpRegReg(x64R8, x64R11)
		fail = append(fail, b.jccRel32(0x5))
		b.binaryRegReg(0x01, x64R10, x64R8)
	}
	patchX64Rel32(b.code, resolved, len(b.code))
	return fixups, fail
}

// RCX=id, RDX=length; RAX=descriptor, RDX=status. No external calls or
// nonvolatile register clobbers. Both validation passes precede cursor commit.
func buildX64BytesFromStorageHelper(moduleLen, ioBytes, storageBytes int) ([]byte, x64ProcessDataFixup, error) {
	if err := validateNativeSnapshotArenas(moduleLen, ioBytes, storageBytes); err != nil {
		return nil, x64ProcessDataFixup{}, err
	}
	b := &x64MachineBuilder{}
	fixup := x64ProcessDataFixup{DispPos: b.leaRegRIPRel32(x64R10), Target: processDataRuntime}
	fail := make([]int, 0, 8)
	b.testRegReg(x64RCX, x64RCX)
	fail = append(fail, b.jccRel32(0x4))
	b.cmpRegImm32(x64RCX, nativeStorageMaxBlocks)
	fail = append(fail, b.jccRel32(0x7))
	b.movRegReg(x64R11, x64R10)
	b.addRegImm32(x64R11, uint32(ioBytes))
	b.movRegReg(x64R9, x64RCX)
	b.subRegImm8(x64R9, 1)
	b.imulRegImm8(x64R9, x64R9, nativeStorageDescriptorBytes)
	b.addRegImm32(x64R9, nativeStorageHeaderBytes)
	b.binaryRegReg(0x01, x64R9, x64R11)
	b.movRegMemDisp32(x64R8, x64R9, 16)
	b.cmpRegImm8(x64R8, 1)
	fail = append(fail, b.jccRel32(0x5))
	b.movRegMemDisp32(x64R8, x64R9, 8)
	b.cmpRegReg(x64RDX, x64R8)
	fail = append(fail, b.jccRel32(0x7))
	b.movRegMemDisp32(x64R8, x64R9, 0)
	b.binaryRegReg(0x01, x64R11, x64R8) // source
	b.movRegMemDisp32(x64R9, x64R10, 0) // committed byte cursor
	b.cmpRegImm32(x64R9, uint32(ioBytes-8))
	fail = append(fail, b.jccRel32(0x7))
	b.movRegImm64(x64R8, uint64(ioBytes-8))
	b.binaryRegReg(0x29, x64R8, x64R9)
	b.cmpRegReg(x64RDX, x64R8)
	fail = append(fail, b.jccRel32(0x7))
	b.movRegReg(x64RAX, x64R11) // preserve source start
	b.movRegReg(x64RCX, x64RDX)
	b.testRegReg(x64RCX, x64RCX)
	empty := b.jccRel32(0x4)
	validate := len(b.code)
	b.movRegMemDisp32(x64R8, x64R11, 0)
	b.cmpRegImm32(x64R8, 255)
	fail = append(fail, b.jccRel32(0x7))
	b.addRegImm8(x64R11, 8)
	b.subRegImm8(x64RCX, 1)
	b.testRegReg(x64RCX, x64RCX)
	more := b.jccRel32(0x5)
	patchX64Rel32(b.code, more, validate)
	b.movRegReg(x64R11, x64RAX)
	b.movRegReg(x64RCX, x64RDX)
	b.movRegReg(x64R8, x64R10)
	b.addRegImm8(x64R8, 8)
	b.binaryRegReg(0x01, x64R8, x64R9)
	copyLoop := len(b.code)
	b.movRegMemDisp32(x64RAX, x64R11, 0)
	b.movMemByteReg(x64R8, x64RAX)
	b.addRegImm8(x64R11, 8)
	b.addRegImm8(x64R8, 1)
	b.subRegImm8(x64RCX, 1)
	b.testRegReg(x64RCX, x64RCX)
	more = b.jccRel32(0x5)
	patchX64Rel32(b.code, more, copyLoop)
	patchX64Rel32(b.code, empty, len(b.code))
	b.movRegReg(x64RAX, x64R9)
	b.addRegImm32(x64RAX, uint32(moduleLen))
	b.shlRegImm8(x64RAX, 32)
	b.binaryRegReg(0x09, x64RAX, x64RDX)
	b.binaryRegReg(0x01, x64R9, x64RDX)
	b.movMemDisp32Reg(x64R10, 0, x64R9)
	b.xorRegReg(x64RDX, x64RDX)
	b.ret()
	for _, pos := range fail {
		patchX64Rel32(b.code, pos, len(b.code))
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	b.ret()
	return b.code, fixup, nil
}

// x0=id, x1=length; x0=descriptor, x1=status. Only caller-saved registers
// are used, and no payload is written until every source word is an octet.
func buildARM64BytesFromStorageHelper(moduleLen, ioBytes, storageBytes int) ([]byte, ARM64ProcessDataFixup, error) {
	if err := validateNativeSnapshotArenas(moduleLen, ioBytes, storageBytes); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b := &arm64MachineBuilder{}
	fixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataRuntime}
	fail := make([]int, 0, 8)
	b.cmpRegReg(0, 31)
	fail = append(fail, b.condBranchPlaceholder(0x0))
	b.movImm64(15, nativeStorageMaxBlocks)
	b.cmpRegReg(0, 15)
	fail = append(fail, b.condBranchPlaceholder(0x8))
	b.movImm64(15, uint64(ioBytes))
	b.addRegReg(11, 9, 15) // storage base
	if err := b.subRegImm(10, 0, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(15, nativeStorageDescriptorBytes)
	b.mul(10, 10, 15)
	if err := b.addRegImm(10, 10, nativeStorageHeaderBytes); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.addRegReg(10, 11, 10)
	if err := b.ldrRegBase(14, 10, 16); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(15, 1)
	b.cmpRegReg(14, 15)
	fail = append(fail, b.condBranchPlaceholder(0x1))
	if err := b.ldrRegBase(14, 10, 8); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.cmpRegReg(1, 14)
	fail = append(fail, b.condBranchPlaceholder(0x8))
	if err := b.ldrRegBase(14, 10, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.addRegReg(11, 11, 14) // source
	if err := b.ldrRegBase(12, 9, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(15, uint64(ioBytes-8))
	b.cmpRegReg(12, 15)
	fail = append(fail, b.condBranchPlaceholder(0x8))
	b.subRegReg(15, 15, 12)
	b.cmpRegReg(1, 15)
	fail = append(fail, b.condBranchPlaceholder(0x8))
	b.movRegReg(13, 11)
	b.movRegReg(14, 1)
	empty := b.cbzPlaceholder(14)
	validate := len(b.words)
	if err := b.ldrRegBase(15, 13, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(16, 255)
	b.cmpRegReg(15, 16)
	fail = append(fail, b.condBranchPlaceholder(0x8))
	if err := b.addRegImm(13, 13, 8); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.subRegImm(14, 14, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.cmpRegReg(14, 31)
	more := b.condBranchPlaceholder(0x1)
	if err := b.patchCondBranch(more, validate); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movRegReg(14, 1)
	if err := b.addRegImm(13, 9, 8); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.addRegReg(13, 13, 12)
	copyLoop := len(b.words)
	if err := b.ldrRegBase(15, 11, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strbRegBase(15, 13, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.addRegImm(11, 11, 8); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.subRegImm(14, 14, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.cmpRegReg(14, 31)
	more = b.condBranchPlaceholder(0x1)
	if err := b.patchCondBranch(more, copyLoop); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.patchCBZ(empty, len(b.words)); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(15, uint64(moduleLen))
	b.addRegReg(0, 12, 15)
	b.movImm64(15, 32)
	b.append(0x9ac02000 | 15<<16) // LSLV x0,x0,x15
	b.logicalRegReg(0xaa000000, 0, 0, 1)
	b.addRegReg(12, 12, 1)
	if err := b.strRegBase(12, 9, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(1, 0)
	b.ret()
	for _, pos := range fail {
		if err := b.patchCondBranch(pos, len(b.words)); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, fixup, nil
}
