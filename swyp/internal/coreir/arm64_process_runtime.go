package coreir

import (
	"encoding/binary"
	"fmt"
	"sort"
)

func arm64ProcessHelperSpec(name string) (stream string, typ Type, ok bool) {
	switch name {
	case "__swyp_rt_stdout_i64":
		return "stdout", I64, true
	case "__swyp_rt_stdout_u64":
		return "stdout", U64, true
	case "__swyp_rt_stdout_bool":
		return "stdout", Bool, true
	case "__swyp_rt_stdout_ieee64":
		return "stdout", IEEE64, true
	case "__swyp_rt_stderr_i64":
		return "stderr", I64, true
	case "__swyp_rt_stderr_u64":
		return "stderr", U64, true
	case "__swyp_rt_stderr_bool":
		return "stderr", Bool, true
	case "__swyp_rt_stderr_ieee64":
		return "stderr", IEEE64, true
	case "__swyp_rt_clock_u64":
		return "clock", U64, true
	case "__swyp_rt_rng_u64":
		return "rng", U64, true
	case "__swyp_rt_fs_write":
		return "fswrite", Void, true
	case "__swyp_rt_fs_read":
		return "fsread", Bytes, true
	case "__swyp_rt_bytes_get":
		return "bytesget", U64, true
	case "__swyp_rt_bytes_from_storage_u64":
		return "bytessnapshot", Bytes, true
	case "__swyp_rt_net_connect":
		return "netconnect", Bool, true
	case "__swyp_rt_net_fetch":
		return "netfetch", Bytes, true
	case "__swyp_rt_storage_alloc_u64":
		return "storage_alloc", U64, true
	case "__swyp_rt_storage_load_u64":
		return "storage_load", U64, true
	case "__swyp_rt_storage_store_u64":
		return "storage_store", Void, true
	case "__swyp_rt_storage_free":
		return "storage_free", Void, true
	default:
		return "", "", false
	}
}

type ARM64ProcessDataFixup struct {
	WordIndex int
	Target    processDataTarget
}

func resolveARM64LinuxProcessRuntime(process ARM64ProcessMachineCode) ([]byte, []ARM64ProcessDataFixup, error) {
	seen := make(map[string]bool)
	for _, fixup := range process.RuntimeFixups {
		if !arm64ProcessRuntimeHelper(fixup.Helper) {
			return nil, nil, fmt.Errorf("arm64 process runtime: unknown helper %q", fixup.Helper)
		}
		seen[fixup.Helper] = true
	}
	helpers := make([]string, 0, len(seen))
	for helper := range seen {
		helpers = append(helpers, helper)
	}
	sort.Strings(helpers)

	code := append([]byte(nil), process.Code...)
	offsets := make(map[string]int, len(helpers)) // word offsets
	dataFixups := make([]ARM64ProcessDataFixup, 0)
	ioRuntimeBytes := process.RuntimeDataBytes - process.StorageDataBytes
	if ioRuntimeBytes < 0 {
		return nil, nil, fmt.Errorf("arm64 process runtime: storage data exceeds runtime data")
	}
	for _, helper := range helpers {
		stream, typ, _ := arm64ProcessHelperSpec(helper)
		offsets[helper] = len(code) / 4
		var runtimeCode []byte
		var err error
		if stream == "clock" {
			runtimeCode, err = buildARM64LinuxClockHelper()
		} else if stream == "rng" {
			runtimeCode, err = buildARM64LinuxRNGHelper()
		} else if stream == "fswrite" {
			var fixups []ARM64ProcessDataFixup
			runtimeCode, fixups, err = buildARM64LinuxFSWriteHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.WordIndex += len(code) / 4
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "fsread" {
			var fixups []ARM64ProcessDataFixup
			runtimeCode, fixups, err = buildARM64LinuxFSReadHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.WordIndex += len(code) / 4
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytesget" {
			var fixups []ARM64ProcessDataFixup
			runtimeCode, fixups, err = buildARM64BytesGetHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.WordIndex += len(code) / 4
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytessnapshot" {
			var fixup ARM64ProcessDataFixup
			runtimeCode, fixup, err = buildARM64BytesFromStorageHelper(len(process.Data), ioRuntimeBytes, process.StorageDataBytes)
			fixup.WordIndex += len(code) / 4
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netconnect" {
			var fixup ARM64ProcessDataFixup
			runtimeCode, fixup, err = buildARM64LinuxNetConnectHelper(len(process.Data))
			fixup.WordIndex += len(code) / 4
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netfetch" {
			var fixups []ARM64ProcessDataFixup
			runtimeCode, fixups, err = buildARM64LinuxNetFetchHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.WordIndex += len(code) / 4
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "storage_alloc" || stream == "storage_load" || stream == "storage_store" || stream == "storage_free" {
			var fixup ARM64ProcessDataFixup
			runtimeCode, fixup, err = buildARM64StorageHelper(stream, ioRuntimeBytes, process.StorageDataBytes)
			fixup.WordIndex += len(code) / 4
			dataFixups = append(dataFixups, fixup)
		} else {
			runtimeCode, err = buildARM64LinuxProcessHelper(stream, typ)
		}
		if err != nil {
			return nil, nil, err
		}
		code = append(code, runtimeCode...)
	}
	for _, fixup := range process.RuntimeFixups {
		target, ok := offsets[fixup.Helper]
		if !ok {
			return nil, nil, fmt.Errorf("arm64 process runtime: unresolved helper %q", fixup.Helper)
		}
		if err := patchARM64BL(code, fixup.WordIndex, target); err != nil {
			return nil, nil, err
		}
	}
	if len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return nil, nil, fmt.Errorf("arm64 process runtime: invalid code size %d", len(code))
	}
	return code, dataFixups, nil
}

func buildARM64BytesGetHelper(moduleLen, runtimeDataBytes int) ([]byte, []ARM64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes {
		return nil, nil, fmt.Errorf("arm64 bytes.get: invalid module arena size %d", moduleLen)
	}
	if runtimeDataBytes < 0 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("arm64 bytes.get: invalid runtime arena size %d", runtimeDataBytes)
	}
	b := &arm64MachineBuilder{}
	fixups := make([]ARM64ProcessDataFixup, 0, 2)
	b.lsrImm(3, 0, 32) // logical offset
	b.movImm64(5, 0xffffffff)
	b.logicalRegReg(0x8a000000, 4, 0, 5) // length
	b.movImm64(6, uint64(moduleLen))
	b.cmpRegReg(3, 6)
	runtimeBranch := b.condBranchPlaceholder(0x2) // HS: offset >= moduleLen

	moduleFailures := make([]int, 0, 2)
	if moduleLen > 0 {
		fixups = append(fixups, ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(2), Target: processDataModule})
		b.subRegReg(7, 6, 3)
		b.cmpRegReg(4, 7)
		moduleFailures = append(moduleFailures, b.condBranchPlaceholder(0x8)) // HI
		b.cmpRegReg(1, 4)
		moduleFailures = append(moduleFailures, b.condBranchPlaceholder(0x2)) // HS
		b.addRegReg(2, 2, 3)
		b.addRegReg(2, 2, 1)
		if err := b.ldrbRegBase(0, 2, 0); err != nil {
			return nil, nil, err
		}
		b.movImm64(1, 0)
		b.ret()
	}

	runtimeOffset := len(b.words)
	if err := b.patchCondBranch(runtimeBranch, runtimeOffset); err != nil {
		return nil, nil, err
	}
	runtimeFailures := make([]int, 0, 3)
	if runtimeDataBytes >= 8 {
		fixups = append(fixups, ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(2), Target: processDataRuntime})
		b.movImm64(6, uint64(moduleLen))
		b.subRegReg(3, 3, 6)                          // runtime payload offset
		if err := b.ldrRegBase(5, 2, 0); err != nil { // committed cursor
			return nil, nil, err
		}
		b.cmpRegReg(3, 5)
		runtimeFailures = append(runtimeFailures, b.condBranchPlaceholder(0x8)) // HI
		b.subRegReg(6, 5, 3)
		b.cmpRegReg(4, 6)
		runtimeFailures = append(runtimeFailures, b.condBranchPlaceholder(0x8))
		b.cmpRegReg(1, 4)
		runtimeFailures = append(runtimeFailures, b.condBranchPlaceholder(0x2)) // HS
		if err := b.addRegImm(2, 2, 8); err != nil {
			return nil, nil, err
		}
		b.addRegReg(2, 2, 3)
		b.addRegReg(2, 2, 1)
		if err := b.ldrbRegBase(0, 2, 0); err != nil {
			return nil, nil, err
		}
		b.movImm64(1, 0)
		b.ret()
	}

	failure := len(b.words)
	for _, pos := range moduleFailures {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, nil, err
		}
	}
	for _, pos := range runtimeFailures {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, nil, err
		}
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, fixups, nil
}

// buildARM64StorageHelper mirrors the bounded standalone x64 storage ABI.
// x0/x1/x2 carry arguments; x0 returns the result and x1 returns status
// (0 success, non-zero bounds/storage failure). Storage IDs are monotonic
// descriptor slot+1 values and never expose process pointers.
func buildARM64StorageHelper(kind string, storageOffset, storageBytes int) ([]byte, ARM64ProcessDataFixup, error) {
	if storageOffset < 0 || storageBytes < nativeStoragePayloadOffset || storageOffset+storageBytes > MaxProcessRuntimeArenaBytes {
		return nil, ARM64ProcessDataFixup{}, fmt.Errorf("arm64 storage runtime: invalid partition offset=%d bytes=%d", storageOffset, storageBytes)
	}
	b := &arm64MachineBuilder{}
	runtimeWord := b.adrPlaceholder(9)
	if storageOffset != 0 {
		b.movImm64(15, uint64(storageOffset))
		b.addRegReg(9, 9, 15)
	}
	fail := make([]int, 0, 8)
	descPtr := func(idReg, dstReg int) error {
		b.movRegReg(dstReg, idReg)
		if err := b.subRegImm(dstReg, dstReg, 1); err != nil {
			return err
		}
		b.movImm64(15, nativeStorageDescriptorBytes)
		b.mul(dstReg, dstReg, 15)
		if err := b.addRegImm(dstReg, dstReg, nativeStorageHeaderBytes); err != nil {
			return err
		}
		b.addRegReg(dstReg, 9, dstReg)
		return nil
	}
	validateID := func(idReg, descReg, scratchReg int) error {
		b.cmpRegReg(idReg, 31)
		fail = append(fail, b.condBranchPlaceholder(0x0)) // EQ
		if err := b.cmpRegImm(idReg, nativeStorageMaxBlocks); err != nil {
			return err
		}
		fail = append(fail, b.condBranchPlaceholder(0x8)) // HI
		if err := descPtr(idReg, descReg); err != nil {
			return err
		}
		if err := b.ldrRegBase(scratchReg, descReg, 16); err != nil {
			return err
		}
		if err := b.cmpRegImm(scratchReg, 1); err != nil {
			return err
		}
		fail = append(fail, b.condBranchPlaceholder(0x1)) // NE
		return nil
	}

	switch kind {
	case "storage_alloc":
		capacityElems := uint64((storageBytes - nativeStoragePayloadOffset) / 8)
		b.movImm64(15, capacityElems)
		b.cmpRegReg(0, 15)
		fail = append(fail, b.condBranchPlaceholder(0x8)) // HI
		if err := b.ldrRegBase(10, 9, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		initID := b.cbzPlaceholder(10)
		skipID := b.branchPlaceholder()
		initIDOffset := len(b.words)
		b.movImm64(10, 1)
		haveIDOffset := len(b.words)
		if err := b.patchCBZ(initID, initIDOffset); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.patchBranch(skipID, haveIDOffset); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.cmpRegImm(10, nativeStorageMaxBlocks); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		fail = append(fail, b.condBranchPlaceholder(0x8))

		if err := b.ldrRegBase(11, 9, 8); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		initCursor := b.cbzPlaceholder(11)
		skipCursor := b.branchPlaceholder()
		initCursorOffset := len(b.words)
		b.movImm64(11, nativeStoragePayloadOffset)
		haveCursorOffset := len(b.words)
		if err := b.patchCBZ(initCursor, initCursorOffset); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.patchBranch(skipCursor, haveCursorOffset); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}

		b.movImm64(15, 8)
		b.mul(12, 0, 15)
		b.movImm64(14, uint64(storageBytes))
		b.subRegReg(14, 14, 11)
		b.cmpRegReg(12, 14)
		fail = append(fail, b.condBranchPlaceholder(0x8))
		if err := descPtr(10, 13); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.strRegBase(11, 13, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.strRegBase(0, 13, 8); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(14, 1)
		if err := b.strRegBase(14, 13, 16); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.addRegReg(11, 11, 12)
		if err := b.strRegBase(11, 9, 8); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movRegReg(0, 10)
		if err := b.addRegImm(10, 10, 1); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.strRegBase(10, 9, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(1, 0)
		b.ret()
	case "storage_load":
		if err := validateID(0, 10, 11); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.ldrRegBase(11, 10, 8); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.cmpRegReg(1, 11)
		fail = append(fail, b.condBranchPlaceholder(0x2)) // HS
		if err := b.ldrRegBase(12, 10, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(15, 8)
		b.mul(13, 1, 15)
		b.addRegReg(12, 12, 13)
		b.addRegReg(12, 9, 12)
		if err := b.ldrRegBase(0, 12, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(1, 0)
		b.ret()
	case "storage_store":
		if err := validateID(0, 10, 11); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.ldrRegBase(11, 10, 8); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.cmpRegReg(1, 11)
		fail = append(fail, b.condBranchPlaceholder(0x2))
		if err := b.ldrRegBase(12, 10, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(15, 8)
		b.mul(13, 1, 15)
		b.addRegReg(12, 12, 13)
		b.addRegReg(12, 9, 12)
		if err := b.strRegBase(2, 12, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(0, 0)
		b.movImm64(1, 0)
		b.ret()
	case "storage_free":
		if err := validateID(0, 10, 11); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(11, 0)
		if err := b.strRegBase(11, 10, 16); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.movImm64(0, 0)
		b.movImm64(1, 0)
		b.ret()
	default:
		return nil, ARM64ProcessDataFixup{}, fmt.Errorf("arm64 storage runtime: unknown helper kind %q", kind)
	}

	failure := len(b.words)
	for _, pos := range fail {
		if err := b.patchCondBranch(pos, failure); err != nil {
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
	return out, ARM64ProcessDataFixup{WordIndex: runtimeWord, Target: processDataRuntime}, nil
}

func buildARM64LinuxFSReadHelper(moduleLen, runtimeDataBytes int) ([]byte, []ARM64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("arm64 fs.read: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
	}
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-336); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(0, 248); err != nil { // path descriptor
		return nil, nil, err
	}
	moduleFixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataModule}
	if err := b.strRegSP(9, 256); err != nil {
		return nil, nil, err
	}
	runtimeFixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataRuntime}
	if err := b.strRegSP(9, 264); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 0xffffffff)
	b.movImm64(16, uint64(moduleLen))

	// Path descriptor from immutable module bytes -> bounded NUL-terminated stack buffer.
	if err := b.ldrRegSP(10, 248); err != nil {
		return nil, nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	badPathEmpty := b.cbzPlaceholder(12)
	if err := b.cmpRegImm(12, 240); err != nil {
		return nil, nil, err
	}
	badPathLong := b.condBranchPlaceholder(0x8) // HI
	b.cmpRegReg(11, 16)
	badPathOffset := b.condBranchPlaceholder(0x8)
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badPathSpan := b.condBranchPlaceholder(0x8)
	if err := b.ldrRegSP(9, 256); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 9, 11)
	if err := b.addRegSPAddress(14, 0); err != nil {
		return nil, nil, err
	}
	b.movRegReg(15, 12)
	copyLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, nil, err
	}
	copyDone := b.cbzPlaceholder(15)
	copyBack := b.branchPlaceholder()
	if err := b.patchBranch(copyBack, copyLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(copyDone, len(b.words)); err != nil {
		return nil, nil, err
	}
	b.movImm64(10, 0)
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}

	// openat(AT_FDCWD, path, O_RDONLY, 0)
	b.movImm64(0, ^uint64(99))
	if err := b.addRegSPAddress(1, 0); err != nil {
		return nil, nil, err
	}
	b.movImm64(2, 0)
	b.movImm64(3, 0)
	b.movImm64(8, 56)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	openFailed := b.condBranchPlaceholder(0xb) // LT
	if err := b.strRegSP(0, 272); err != nil {
		return nil, nil, err
	}

	postOpenFailures := make([]int, 0, 5)

	// lseek(fd, 0, SEEK_END) obtains a bounded regular-file size.
	b.movImm64(1, 0)
	b.movImm64(2, 2)
	b.movImm64(8, 62)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postOpenFailures = append(postOpenFailures, b.condBranchPlaceholder(0xb)) // LT
	if err := b.strRegSP(0, 280); err != nil {
		return nil, nil, err
	}

	// Reserve from runtime payload [base+8, base+runtimeDataBytes), but do not
	// commit the cursor until the full read has completed.
	if err := b.ldrRegSP(10, 264); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegBase(11, 10, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(11, 288); err != nil {
		return nil, nil, err
	}
	b.movImm64(12, uint64(runtimeDataBytes-8))
	b.cmpRegReg(11, 12)
	postOpenFailures = append(postOpenFailures, b.condBranchPlaceholder(0x8)) // cursor > capacity
	b.subRegReg(13, 12, 11)
	if err := b.ldrRegSP(14, 280); err != nil {
		return nil, nil, err
	}
	b.cmpRegReg(14, 13)
	postOpenFailures = append(postOpenFailures, b.condBranchPlaceholder(0x8)) // size > remaining

	// Rewind before read; non-seekable inputs fail closed under this contract.
	if err := b.ldrRegSP(0, 272); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 0)
	b.movImm64(2, 0)
	b.movImm64(8, 62)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postOpenFailures = append(postOpenFailures, b.condBranchPlaceholder(0x1)) // NE

	// read(fd, runtime+8+cursor, size)
	if err := b.ldrRegSP(0, 272); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(10, 264); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(1, 10, 8); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(11, 288); err != nil {
		return nil, nil, err
	}
	b.addRegReg(1, 1, 11)
	if err := b.ldrRegSP(2, 280); err != nil {
		return nil, nil, err
	}
	b.movImm64(8, 63)
	b.append(0xd4000001)
	b.cmpRegReg(0, 2)
	postOpenFailures = append(postOpenFailures, b.condBranchPlaceholder(0x1)) // NE: short/error read

	// Commit cursor and encode descriptor only after the exact read completed.
	if err := b.ldrRegSP(10, 264); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(11, 288); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(12, 280); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 11, 12)
	b.strReg(10, 13)
	b.movImm64(13, uint64(moduleLen))
	b.addRegReg(14, 11, 13)
	b.movImm64(15, 1<<32)
	b.mul(14, 14, 15)
	b.logicalRegReg(0xaa000000, 14, 14, 12) // descriptor offset<<32 | length
	if err := b.strRegSP(14, 304); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 0)
	if err := b.strRegSP(17, 312); err != nil {
		return nil, nil, err
	}
	closePath := b.branchPlaceholder()

	readFailure := len(b.words)
	for _, fixup := range postOpenFailures {
		if err := b.patchCondBranch(fixup, readFailure); err != nil {
			return nil, nil, err
		}
	}
	b.movImm64(17, 0)
	if err := b.strRegSP(17, 304); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 1)
	if err := b.strRegSP(17, 312); err != nil {
		return nil, nil, err
	}
	if err := b.patchBranch(closePath, len(b.words)); err != nil {
		return nil, nil, err
	}

	// close(fd) on every path after a successful open.
	if err := b.ldrRegSP(0, 272); err != nil {
		return nil, nil, err
	}
	b.movImm64(8, 57)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	closeOK := b.condBranchPlaceholder(0xa) // GE
	b.movImm64(17, 1)
	if err := b.strRegSP(17, 312); err != nil {
		return nil, nil, err
	}
	if err := b.patchCondBranch(closeOK, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(0, 304); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(1, 312); err != nil {
		return nil, nil, err
	}
	done := b.branchPlaceholder()

	failure := len(b.words)
	if err := b.patchCBZ(badPathEmpty, failure); err != nil {
		return nil, nil, err
	}
	for _, pos := range []int{badPathLong, badPathOffset, badPathSpan} {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, nil, err
		}
	}
	if err := b.patchCondBranch(openFailed, failure); err != nil {
		return nil, nil, err
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	if err := b.patchBranch(done, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := b.adjustSP(336); err != nil {
		return nil, nil, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, []ARM64ProcessDataFixup{moduleFixup, runtimeFixup}, nil
}

func buildARM64LinuxNetConnectHelper(arenaLen int) ([]byte, ARM64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes {
		return nil, ARM64ProcessDataFixup{}, fmt.Errorf("arm64 net.connect: invalid arena size %d", arenaLen)
	}
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-128); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strRegSP(0, 96); err != nil { // host descriptor
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strRegSP(1, 104); err != nil { // port
		return nil, ARM64ProcessDataFixup{}, err
	}
	dataFixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9)}

	// Decode and bounds-check immutable host bytes.
	if err := b.ldrRegSP(10, 96); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.lsrImm(11, 10, 32)
	b.movImm64(17, 0xffffffff)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	badHostEmpty := b.cbzPlaceholder(12)
	if err := b.cmpRegImm(12, 15); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	badHostLong := b.condBranchPlaceholder(0x8) // HI
	b.movImm64(16, uint64(arenaLen))
	b.cmpRegReg(11, 16)
	badHostOffset := b.condBranchPlaceholder(0x8)
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badHostSpan := b.condBranchPlaceholder(0x8)
	b.addRegReg(13, 9, 11)
	if err := b.addRegSPAddress(14, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movRegReg(15, 12)
	copyLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	copyDone := b.cbzPlaceholder(15)
	copyBack := b.branchPlaceholder()
	if err := b.patchBranch(copyBack, copyLoop); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.patchCBZ(copyDone, len(b.words)); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(10, 0)
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}

	// Validate port 1..65535 and construct sockaddr_in at sp+32.
	if err := b.ldrRegSP(10, 104); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	badPortZero := b.cbzPlaceholder(10)
	b.movImm64(16, 65535)
	b.cmpRegReg(10, 16)
	badPortHigh := b.condBranchPlaceholder(0x8) // HI
	if err := b.addRegSPAddress(13, 32); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(14, 2)
	if err := b.strbRegBase(14, 13, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(14, 0)
	if err := b.strbRegBase(14, 13, 1); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.lsrImm(14, 10, 8)
	if err := b.strbRegBase(14, 13, 2); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strbRegBase(10, 13, 3); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}

	// Parse exactly four dotted-decimal octets from the copied host buffer.
	if err := b.addRegSPAddress(14, 0); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.addRegSPAddress(13, 36); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	parseFailures := make([]struct {
		index int
		cbz   bool
	}, 0, 20)
	b.movImm64(17, 10)
	for octet := 0; octet < 4; octet++ {
		b.movImm64(10, 0) // accumulator
		b.movImm64(11, 0) // digit count
		loop := len(b.words)
		if err := b.ldrbRegBase(12, 14, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.cmpRegImm(12, '0'); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		below := b.condBranchPlaceholder(0x3) // LO
		if err := b.cmpRegImm(12, '9'); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		above := b.condBranchPlaceholder(0x8) // HI
		if err := b.subRegImm(12, 12, '0'); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		b.mul(10, 10, 17)
		b.addRegReg(10, 10, 12)
		if err := b.cmpRegImm(10, 255); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		parseFailures = append(parseFailures, struct {
			index int
			cbz   bool
		}{b.condBranchPlaceholder(0x8), false})
		if err := b.addRegImm(14, 14, 1); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.addRegImm(11, 11, 1); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		back := b.branchPlaceholder()
		if err := b.patchBranch(back, loop); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		delimiter := len(b.words)
		if err := b.patchCondBranch(below, delimiter); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.patchCondBranch(above, delimiter); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		parseFailures = append(parseFailures, struct {
			index int
			cbz   bool
		}{b.cbzPlaceholder(11), true})
		if octet < 3 {
			if err := b.cmpRegImm(12, '.'); err != nil {
				return nil, ARM64ProcessDataFixup{}, err
			}
			parseFailures = append(parseFailures, struct {
				index int
				cbz   bool
			}{b.condBranchPlaceholder(0x1), false})
			if err := b.addRegImm(14, 14, 1); err != nil {
				return nil, ARM64ProcessDataFixup{}, err
			}
		} else {
			// The fourth octet must end at the NUL terminator: any other
			// trailing byte is invalid input.
			parseFailures = append(parseFailures, struct {
				index int
				cbz   bool
			}{b.cbnzPlaceholder(12), true})
		}
		if err := b.strbRegBase(10, 13, 0); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
		if err := b.addRegImm(13, 13, 1); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
	}
	b.movImm64(10, 0)
	if err := b.strRegSP(10, 40); err != nil { // zero sin_zero
		return nil, ARM64ProcessDataFixup{}, err
	}

	// socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
	b.movImm64(0, 2)
	b.movImm64(1, 1)
	b.movImm64(2, 6)
	b.movImm64(8, 198)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	socketOK := b.condBranchPlaceholder(0xa) // GE
	socketFailed := b.branchPlaceholder()
	if err := b.patchCondBranch(socketOK, len(b.words)); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.strRegSP(0, 80); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}

	// connect(fd,&sockaddr,16); refusal is bool false with status 0.
	if err := b.addRegSPAddress(1, 32); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(2, 16)
	b.movImm64(8, 203)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	b.cset(10, 0x0) // EQ -> connected
	if err := b.strRegSP(10, 88); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}

	// close(fd)
	if err := b.ldrRegSP(0, 80); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(8, 57)
	b.append(0xd4000001)
	if err := b.ldrRegSP(0, 88); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(1, 0)
	done := b.branchPlaceholder()

	failure := len(b.words)
	if err := b.patchCBZ(badHostEmpty, failure); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	for _, pos := range []int{badHostLong, badHostOffset, badHostSpan, badPortHigh} {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
	}
	if err := b.patchCBZ(badPortZero, failure); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	for _, fixup := range parseFailures {
		var err error
		if fixup.cbz {
			err = b.patchCBZ(fixup.index, failure)
		} else {
			err = b.patchCondBranch(fixup.index, failure)
		}
		if err != nil {
			return nil, ARM64ProcessDataFixup{}, err
		}
	}
	if err := b.patchBranch(socketFailed, failure); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	if err := b.patchBranch(done, len(b.words)); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	if err := b.adjustSP(128); err != nil {
		return nil, ARM64ProcessDataFixup{}, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, dataFixup, nil
}

func emitARM64RuntimeLiteral(b *arm64MachineBuilder, ptrReg, scratchReg int, text string) error {
	for i := 0; i < len(text); i++ {
		b.movImm64(scratchReg, uint64(text[i]))
		if err := b.strbRegBase(scratchReg, ptrReg, 0); err != nil {
			return err
		}
		if err := b.addRegImm(ptrReg, ptrReg, 1); err != nil {
			return err
		}
	}
	return nil
}

func buildARM64LinuxNetFetchHelper(moduleLen, runtimeDataBytes int) ([]byte, []ARM64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("arm64 net.fetch: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
	}
	const (
		frameBytes    = 2432
		requestBase   = 0
		hostBase      = 2176
		sockaddrBase  = 2208
		timevalBase   = 2224
		scratchBase   = 2240
		hostDesc      = 2280
		portSlot      = 2288
		pathDesc      = 2296
		moduleBase    = 2304
		runtimeBase   = 2312
		fdSlot        = 2320
		cursorSlot    = 2328
		respLenSlot   = 2336
		respPtrSlot   = 2344
		reqLenSlot    = 2352
		resultSlot    = 2360
		statusSlot    = 2368
		remainSlot    = 2376
		reqPtrSlot    = 2384
		pollfdSlot    = 2392
		oldFlagsSlot  = 2400
		socketErrSlot = 2408
		socklenSlot   = 2416
	)
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-frameBytes); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(0, hostDesc); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(1, portSlot); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(2, pathDesc); err != nil {
		return nil, nil, err
	}
	moduleFixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataModule}
	if err := b.strRegSP(9, moduleBase); err != nil {
		return nil, nil, err
	}
	runtimeFixup := ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataRuntime}
	if err := b.strRegSP(9, runtimeBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 0xffffffff)
	b.movImm64(16, uint64(moduleLen))

	// Host is a bounded immutable IPv4 literal.
	if err := b.ldrRegSP(10, hostDesc); err != nil {
		return nil, nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	badHostEmpty := b.cbzPlaceholder(12)
	if err := b.cmpRegImm(12, 15); err != nil {
		return nil, nil, err
	}
	badHostLong := b.condBranchPlaceholder(0x8)
	b.cmpRegReg(11, 16)
	badHostOffset := b.condBranchPlaceholder(0x8)
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badHostSpan := b.condBranchPlaceholder(0x8)
	if err := b.ldrRegSP(9, moduleBase); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 9, 11)
	if err := b.addRegSPAddress(14, hostBase); err != nil {
		return nil, nil, err
	}
	b.movRegReg(15, 12)
	hostCopyLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, nil, err
	}
	hostCopyDone := b.cbzPlaceholder(15)
	hostCopyBack := b.branchPlaceholder()
	if err := b.patchBranch(hostCopyBack, hostCopyLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(hostCopyDone, len(b.words)); err != nil {
		return nil, nil, err
	}
	b.movImm64(10, 0)
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}

	// Path must be immutable visible ASCII, begin with '/', and fit the request buffer.
	if err := b.ldrRegSP(10, pathDesc); err != nil {
		return nil, nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	badPathEmpty := b.cbzPlaceholder(12)
	if err := b.cmpRegImm(12, 2048); err != nil {
		return nil, nil, err
	}
	badPathLong := b.condBranchPlaceholder(0x8)
	b.cmpRegReg(11, 16)
	badPathOffset := b.condBranchPlaceholder(0x8)
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badPathSpan := b.condBranchPlaceholder(0x8)
	if err := b.ldrRegSP(9, moduleBase); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 9, 11)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.cmpRegImm(10, '/'); err != nil {
		return nil, nil, err
	}
	badPathRoot := b.condBranchPlaceholder(0x1)
	b.movRegReg(15, 12)
	pathValidateLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.cmpRegImm(10, 0x21); err != nil {
		return nil, nil, err
	}
	badPathLow := b.condBranchPlaceholder(0x3)
	if err := b.cmpRegImm(10, 0x7e); err != nil {
		return nil, nil, err
	}
	badPathHigh := b.condBranchPlaceholder(0x8)
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, nil, err
	}
	pathValidateDone := b.cbzPlaceholder(15)
	pathValidateBack := b.branchPlaceholder()
	if err := b.patchBranch(pathValidateBack, pathValidateLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(pathValidateDone, len(b.words)); err != nil {
		return nil, nil, err
	}

	// Construct the exact HTTP/1.1 request.
	if err := b.addRegSPAddress(14, requestBase); err != nil {
		return nil, nil, err
	}
	if err := emitARM64RuntimeLiteral(b, 14, 10, "GET "); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(10, pathDesc); err != nil {
		return nil, nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	if err := b.ldrRegSP(9, moduleBase); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 9, 11)
	b.movRegReg(15, 12)
	reqPathLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, nil, err
	}
	reqPathDone := b.cbzPlaceholder(15)
	reqPathBack := b.branchPlaceholder()
	if err := b.patchBranch(reqPathBack, reqPathLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(reqPathDone, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := emitARM64RuntimeLiteral(b, 14, 10, " HTTP/1.1\r\nHost: "); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(13, hostBase); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(10, hostDesc); err != nil {
		return nil, nil, err
	}
	b.logicalRegReg(0x8a000000, 15, 10, 17)
	reqHostLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, nil, err
	}
	reqHostDone := b.cbzPlaceholder(15)
	reqHostBack := b.branchPlaceholder()
	if err := b.patchBranch(reqHostBack, reqHostLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(reqHostDone, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := emitARM64RuntimeLiteral(b, 14, 10, "\r\nConnection: close\r\n\r\n"); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(13, requestBase); err != nil {
		return nil, nil, err
	}
	b.subRegReg(10, 14, 13)
	if err := b.strRegSP(10, reqLenSlot); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(13, reqPtrSlot); err != nil {
		return nil, nil, err
	}

	// Validate port and construct sockaddr_in.
	if err := b.ldrRegSP(10, portSlot); err != nil {
		return nil, nil, err
	}
	badPortZero := b.cbzPlaceholder(10)
	b.movImm64(16, 65535)
	b.cmpRegReg(10, 16)
	badPortHigh := b.condBranchPlaceholder(0x8)
	if err := b.addRegSPAddress(13, sockaddrBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(14, 2)
	if err := b.strbRegBase(14, 13, 0); err != nil {
		return nil, nil, err
	}
	b.movImm64(14, 0)
	if err := b.strbRegBase(14, 13, 1); err != nil {
		return nil, nil, err
	}
	b.lsrImm(14, 10, 8)
	if err := b.strbRegBase(14, 13, 2); err != nil {
		return nil, nil, err
	}
	if err := b.strbRegBase(10, 13, 3); err != nil {
		return nil, nil, err
	}

	if err := b.addRegSPAddress(14, hostBase); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(13, sockaddrBase+4); err != nil {
		return nil, nil, err
	}
	parseFailures := make([]struct {
		index int
		cbz   bool
	}, 0, 20)
	b.movImm64(17, 10)
	for octet := 0; octet < 4; octet++ {
		b.movImm64(10, 0)
		b.movImm64(11, 0)
		loop := len(b.words)
		if err := b.ldrbRegBase(12, 14, 0); err != nil {
			return nil, nil, err
		}
		if err := b.cmpRegImm(12, '0'); err != nil {
			return nil, nil, err
		}
		below := b.condBranchPlaceholder(0x3)
		if err := b.cmpRegImm(12, '9'); err != nil {
			return nil, nil, err
		}
		above := b.condBranchPlaceholder(0x8)
		if err := b.subRegImm(12, 12, '0'); err != nil {
			return nil, nil, err
		}
		b.mul(10, 10, 17)
		b.addRegReg(10, 10, 12)
		if err := b.cmpRegImm(10, 255); err != nil {
			return nil, nil, err
		}
		parseFailures = append(parseFailures, struct {
			index int
			cbz   bool
		}{b.condBranchPlaceholder(0x8), false})
		if err := b.addRegImm(14, 14, 1); err != nil {
			return nil, nil, err
		}
		if err := b.addRegImm(11, 11, 1); err != nil {
			return nil, nil, err
		}
		back := b.branchPlaceholder()
		if err := b.patchBranch(back, loop); err != nil {
			return nil, nil, err
		}
		delimiter := len(b.words)
		if err := b.patchCondBranch(below, delimiter); err != nil {
			return nil, nil, err
		}
		if err := b.patchCondBranch(above, delimiter); err != nil {
			return nil, nil, err
		}
		parseFailures = append(parseFailures, struct {
			index int
			cbz   bool
		}{b.cbzPlaceholder(11), true})
		if octet < 3 {
			if err := b.cmpRegImm(12, '.'); err != nil {
				return nil, nil, err
			}
			parseFailures = append(parseFailures, struct {
				index int
				cbz   bool
			}{b.condBranchPlaceholder(0x1), false})
			if err := b.addRegImm(14, 14, 1); err != nil {
				return nil, nil, err
			}
		} else {
			// The fourth octet must end at the NUL terminator: any other
			// trailing byte is invalid input.
			parseFailures = append(parseFailures, struct {
				index int
				cbz   bool
			}{b.cbnzPlaceholder(12), true})
		}
		if err := b.strbRegBase(10, 13, 0); err != nil {
			return nil, nil, err
		}
		if err := b.addRegImm(13, 13, 1); err != nil {
			return nil, nil, err
		}
	}
	b.movImm64(10, 0)
	if err := b.strRegSP(10, sockaddrBase+8); err != nil {
		return nil, nil, err
	}

	// socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
	b.movImm64(0, 2)
	b.movImm64(1, 1)
	b.movImm64(2, 6)
	b.movImm64(8, 198)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	socketFailed := b.condBranchPlaceholder(0xb) // LT
	if err := b.strRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}

	postSocketFailures := make([]int, 0, 16)
	// Fixed 5 second send/receive timeout.
	b.movImm64(10, 5)
	if err := b.strRegSP(10, timevalBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(10, 0)
	if err := b.strRegSP(10, timevalBase+8); err != nil {
		return nil, nil, err
	}
	for _, opt := range []uint64{20, 21} {
		if err := b.ldrRegSP(0, fdSlot); err != nil {
			return nil, nil, err
		}
		b.movImm64(1, 1)
		b.movImm64(2, opt)
		if err := b.addRegSPAddress(3, timevalBase); err != nil {
			return nil, nil, err
		}
		b.movImm64(4, 16)
		b.movImm64(8, 208)
		b.append(0xd4000001)
		b.cmpRegReg(0, 31)
		postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))
	}

	// Temporarily switch the socket to non-blocking mode so connect has an
	// explicit deadline rather than inheriting the kernel TCP retry horizon.
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 3) // F_GETFL
	b.movImm64(2, 0)
	b.movImm64(8, 25)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))
	if err := b.strRegSP(0, oldFlagsSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(10, 0x800) // O_NONBLOCK
	b.logicalRegReg(0xaa000000, 2, 0, 10)
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 4) // F_SETFL
	b.movImm64(8, 25)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))

	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(1, sockaddrBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(2, 16)
	b.movImm64(8, 203)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	connectImmediate := b.condBranchPlaceholder(0x0)
	b.movImm64(10, ^uint64(114)) // -EINPROGRESS
	b.cmpRegReg(0, 10)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x1))

	if err := b.ldrRegSP(10, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(11, uint64(4)<<32) // pollfd.events = POLLOUT
	b.logicalRegReg(0xaa000000, 10, 10, 11)
	if err := b.strRegSP(10, pollfdSlot); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(0, pollfdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 1)
	if err := b.addRegSPAddress(2, timevalBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(3, 0)
	b.movImm64(4, 0)
	b.movImm64(8, 73) // ppoll
	b.append(0xd4000001)
	if err := b.cmpRegImm(0, 1); err != nil {
		return nil, nil, err
	}
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x1))

	b.movImm64(10, 0)
	if err := b.strRegSP(10, socketErrSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(10, 4)
	if err := b.strRegSP(10, socklenSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 1) // SOL_SOCKET
	b.movImm64(2, 4) // SO_ERROR
	if err := b.addRegSPAddress(3, socketErrSlot); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(4, socklenSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(8, 209)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x1))
	if err := b.ldrRegSP(10, socketErrSlot); err != nil {
		return nil, nil, err
	}
	b.cmpRegReg(10, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x1))

	connectComplete := len(b.words)
	if err := b.patchCondBranch(connectImmediate, connectComplete); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(1, 4) // F_SETFL
	if err := b.ldrRegSP(2, oldFlagsSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(8, 25)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))

	// sendto(..., MSG_NOSIGNAL, NULL, 0) until the full request is sent.
	writeLoop := len(b.words)
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(1, reqPtrSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(2, reqLenSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(3, 0x4000)
	b.movImm64(4, 0)
	b.movImm64(5, 0)
	b.movImm64(8, 206)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x0))
	if err := b.ldrRegSP(10, reqPtrSlot); err != nil {
		return nil, nil, err
	}
	b.addRegReg(10, 10, 0)
	if err := b.strRegSP(10, reqPtrSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(10, reqLenSlot); err != nil {
		return nil, nil, err
	}
	b.subRegReg(10, 10, 0)
	if err := b.strRegSP(10, reqLenSlot); err != nil {
		return nil, nil, err
	}
	writeDone := b.cbzPlaceholder(10)
	writeBack := b.branchPlaceholder()
	if err := b.patchBranch(writeBack, writeLoop); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(writeDone, len(b.words)); err != nil {
		return nil, nil, err
	}

	// Reserve the runtime arena tail; commit only after clean EOF.
	if err := b.ldrRegSP(10, runtimeBase); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegBase(11, 10, 0); err != nil {
		return nil, nil, err
	}
	if err := b.strRegSP(11, cursorSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(12, uint64(runtimeDataBytes-8))
	b.cmpRegReg(11, 12)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x8))
	b.subRegReg(13, 12, 11)
	if err := b.strRegSP(13, remainSlot); err != nil {
		return nil, nil, err
	}
	if err := b.addRegImm(14, 10, 8); err != nil {
		return nil, nil, err
	}
	b.addRegReg(14, 14, 11)
	if err := b.strRegSP(14, respPtrSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(15, 0)
	if err := b.strRegSP(15, respLenSlot); err != nil {
		return nil, nil, err
	}

	readLoop := len(b.words)
	if err := b.ldrRegSP(2, remainSlot); err != nil {
		return nil, nil, err
	}
	noRemaining := b.cbzPlaceholder(2)
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(1, respPtrSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(11, respLenSlot); err != nil {
		return nil, nil, err
	}
	b.addRegReg(1, 1, 11)
	b.movImm64(8, 63)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0xb))
	readEOF := b.condBranchPlaceholder(0x0)
	if err := b.ldrRegSP(11, respLenSlot); err != nil {
		return nil, nil, err
	}
	b.addRegReg(11, 11, 0)
	if err := b.strRegSP(11, respLenSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(12, remainSlot); err != nil {
		return nil, nil, err
	}
	b.subRegReg(12, 12, 0)
	if err := b.strRegSP(12, remainSlot); err != nil {
		return nil, nil, err
	}
	readBack := b.branchPlaceholder()
	if err := b.patchBranch(readBack, readLoop); err != nil {
		return nil, nil, err
	}

	overflowProbe := len(b.words)
	if err := b.patchCBZ(noRemaining, overflowProbe); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	if err := b.addRegSPAddress(1, scratchBase); err != nil {
		return nil, nil, err
	}
	b.movImm64(2, 1)
	b.movImm64(8, 63)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	postSocketFailures = append(postSocketFailures, b.condBranchPlaceholder(0x1)) // NE: byte or error

	success := len(b.words)
	if err := b.patchCondBranch(readEOF, success); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(10, runtimeBase); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(11, cursorSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(12, respLenSlot); err != nil {
		return nil, nil, err
	}
	b.addRegReg(13, 11, 12)
	b.strReg(10, 13)
	b.movImm64(13, uint64(moduleLen))
	b.addRegReg(14, 11, 13)
	b.movImm64(15, 1<<32)
	b.mul(14, 14, 15)
	b.logicalRegReg(0xaa000000, 14, 14, 12)
	if err := b.strRegSP(14, resultSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 0)
	if err := b.strRegSP(17, statusSlot); err != nil {
		return nil, nil, err
	}
	closePath := b.branchPlaceholder()

	postSocketFailure := len(b.words)
	for _, pos := range postSocketFailures {
		if err := b.patchCondBranch(pos, postSocketFailure); err != nil {
			return nil, nil, err
		}
	}
	b.movImm64(17, 0)
	if err := b.strRegSP(17, resultSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 1)
	if err := b.strRegSP(17, statusSlot); err != nil {
		return nil, nil, err
	}
	if err := b.patchBranch(closePath, len(b.words)); err != nil {
		return nil, nil, err
	}

	// close(fd) on every path after socket creation.
	if err := b.ldrRegSP(0, fdSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(8, 57)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	closeOK := b.condBranchPlaceholder(0xa)
	b.movImm64(17, 0)
	if err := b.strRegSP(17, resultSlot); err != nil {
		return nil, nil, err
	}
	b.movImm64(17, 1)
	if err := b.strRegSP(17, statusSlot); err != nil {
		return nil, nil, err
	}
	if err := b.patchCondBranch(closeOK, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(0, resultSlot); err != nil {
		return nil, nil, err
	}
	if err := b.ldrRegSP(1, statusSlot); err != nil {
		return nil, nil, err
	}
	done := b.branchPlaceholder()

	failure := len(b.words)
	if err := b.patchCBZ(badHostEmpty, failure); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(badPathEmpty, failure); err != nil {
		return nil, nil, err
	}
	if err := b.patchCBZ(badPortZero, failure); err != nil {
		return nil, nil, err
	}
	for _, pos := range []int{badHostLong, badHostOffset, badHostSpan, badPathLong, badPathOffset, badPathSpan, badPathRoot, badPathLow, badPathHigh, badPortHigh, socketFailed} {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, nil, err
		}
	}
	for _, fixup := range parseFailures {
		var err error
		if fixup.cbz {
			err = b.patchCBZ(fixup.index, failure)
		} else {
			err = b.patchCondBranch(fixup.index, failure)
		}
		if err != nil {
			return nil, nil, err
		}
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	if err := b.patchBranch(done, len(b.words)); err != nil {
		return nil, nil, err
	}
	if err := b.adjustSP(frameBytes); err != nil {
		return nil, nil, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, []ARM64ProcessDataFixup{moduleFixup, runtimeFixup}, nil
}

func buildARM64LinuxRNGHelper() ([]byte, error) {
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-16); err != nil {
		return nil, err
	}
	if err := b.addRegSPAddress(0, 0); err != nil {
		return nil, err
	}
	b.movImm64(1, 8)
	b.movImm64(2, 0)
	b.movImm64(8, 278) // getrandom
	b.append(0xd4000001)
	if err := b.cmpRegImm(0, 8); err != nil {
		return nil, err
	}
	failure := b.condBranchPlaceholder(0x1) // NE
	if err := b.ldrRegSP(0, 0); err != nil {
		return nil, err
	}
	b.movImm64(1, 0)
	done := b.branchPlaceholder()
	failureOffset := len(b.words)
	if err := b.patchCondBranch(failure, failureOffset); err != nil {
		return nil, err
	}
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	if err := b.patchBranch(done, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.adjustSP(16); err != nil {
		return nil, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, nil
}

func patchARM64ADR(code []byte, wordIndex, targetWord int) error {
	if wordIndex < 0 || wordIndex*4+4 > len(code) {
		return fmt.Errorf("arm64 process runtime: ADR fixup outside code")
	}
	byteRel := int64(targetWord-wordIndex) * 4
	if byteRel < -(1<<20) || byteRel >= 1<<20 {
		return fmt.Errorf("arm64 process runtime: ADR target out of range")
	}
	word := binary.LittleEndian.Uint32(code[wordIndex*4 : wordIndex*4+4])
	imm := uint32(int32(byteRel)) & 0x1fffff
	word &= 0x9f00001f
	word |= (imm & 0x3) << 29
	word |= ((imm >> 2) & 0x7ffff) << 5
	binary.LittleEndian.PutUint32(code[wordIndex*4:wordIndex*4+4], word)
	return nil
}

func buildARM64LinuxFSWriteHelper(arenaLen, runtimeBytes int) ([]byte, []ARM64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes || runtimeBytes < 0 || runtimeBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("arm64 fs.write: invalid arena sizes %d/%d", arenaLen, runtimeBytes)
	}
	b := &arm64MachineBuilder{}
	fixups, err := emitARM64LinuxFSWrite(b, arenaLen, runtimeBytes)
	if err != nil {
		return nil, nil, err
	}
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, fixups, nil
}

func emitARM64LinuxFSWrite(b *arm64MachineBuilder, arenaLen, runtimeBytes int) ([]ARM64ProcessDataFixup, error) {
	if err := b.adjustSP(-288); err != nil {
		return nil, err
	}
	if err := b.strRegSP(0, 248); err != nil {
		return nil, err
	}
	if err := b.strRegSP(1, 256); err != nil {
		return nil, err
	}
	dataFixups := []ARM64ProcessDataFixup{{WordIndex: b.adrPlaceholder(9), Target: processDataModule}}
	if err := b.strRegSP(9, 264); err != nil {
		return nil, err
	}
	b.movImm64(17, 0xffffffff)
	b.movImm64(16, uint64(arenaLen))

	// Path descriptor: x10 raw, x11 offset, x12 length.
	if err := b.ldrRegSP(10, 248); err != nil {
		return nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	badPathEmpty := b.cbzPlaceholder(12)
	if err := b.cmpRegImm(12, 240); err != nil {
		return nil, err
	}
	badPathLong := b.condBranchPlaceholder(0x8) // HI
	b.cmpRegReg(11, 16)
	badPathOffset := b.condBranchPlaceholder(0x8)
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badPathSpan := b.condBranchPlaceholder(0x8)
	if err := b.ldrRegSP(9, 264); err != nil {
		return nil, err
	}
	b.addRegReg(13, 9, 11)
	if err := b.addRegSPAddress(14, 0); err != nil {
		return nil, err
	}
	b.movRegReg(15, 12)
	copyLoop := len(b.words)
	if err := b.ldrbRegBase(10, 13, 0); err != nil {
		return nil, err
	}
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, err
	}
	if err := b.addRegImm(13, 13, 1); err != nil {
		return nil, err
	}
	if err := b.addRegImm(14, 14, 1); err != nil {
		return nil, err
	}
	if err := b.subRegImm(15, 15, 1); err != nil {
		return nil, err
	}
	copyDone := b.cbzPlaceholder(15)
	copyBack := b.branchPlaceholder()
	if err := b.patchBranch(copyBack, copyLoop); err != nil {
		return nil, err
	}
	if err := b.patchCBZ(copyDone, len(b.words)); err != nil {
		return nil, err
	}
	b.movImm64(10, 0)
	if err := b.strbRegBase(10, 14, 0); err != nil {
		return nil, err
	}

	// Data descriptor -> arena pointer and length.
	if err := b.ldrRegSP(10, 256); err != nil {
		return nil, err
	}
	b.lsrImm(11, 10, 32)
	b.logicalRegReg(0x8a000000, 12, 10, 17)
	b.cmpRegReg(11, 16)
	runtimeData := b.condBranchPlaceholder(0x2) // HS
	b.subRegReg(13, 16, 11)
	b.cmpRegReg(12, 13)
	badDataSpan := b.condBranchPlaceholder(0x8)
	if err := b.ldrRegSP(9, 264); err != nil {
		return nil, err
	}
	b.addRegReg(13, 9, 11)
	resolvedData := b.branchPlaceholder()
	if err := b.patchCondBranch(runtimeData, len(b.words)); err != nil {
		return nil, err
	}
	var dataFailures []int
	if runtimeBytes >= 8 {
		dataFixups = append(dataFixups, ARM64ProcessDataFixup{WordIndex: b.adrPlaceholder(9), Target: processDataRuntime})
		b.movImm64(15, uint64(arenaLen))
		b.subRegReg(11, 11, 15)
		if err := b.ldrRegBase(14, 9, 0); err != nil {
			return nil, err
		}
		b.movImm64(15, uint64(runtimeBytes-8))
		b.cmpRegReg(14, 15)
		dataFailures = append(dataFailures, b.condBranchPlaceholder(0x8))
		b.cmpRegReg(11, 14)
		dataFailures = append(dataFailures, b.condBranchPlaceholder(0x8))
		b.subRegReg(14, 14, 11)
		b.cmpRegReg(12, 14)
		dataFailures = append(dataFailures, b.condBranchPlaceholder(0x8))
		if err := b.addRegImm(13, 9, 8); err != nil {
			return nil, err
		}
		b.addRegReg(13, 13, 11)
	} else {
		b.cmpRegReg(12, 31)
		dataFailures = append(dataFailures, b.condBranchPlaceholder(0x1))
		b.cmpRegReg(11, 16)
		dataFailures = append(dataFailures, b.condBranchPlaceholder(0x1))
		if err := b.ldrRegSP(9, 264); err != nil {
			return nil, err
		}
		b.addRegReg(13, 9, 11)
	}
	if err := b.patchBranch(resolvedData, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.strRegSP(13, 272); err != nil {
		return nil, err
	}
	if err := b.strRegSP(12, 280); err != nil {
		return nil, err
	}

	// openat(AT_FDCWD, path, O_WRONLY|O_CREAT|O_TRUNC, 0644)
	b.movImm64(0, ^uint64(99))
	if err := b.addRegSPAddress(1, 0); err != nil {
		return nil, err
	}
	b.movImm64(2, 577)
	b.movImm64(3, 0644)
	b.movImm64(8, 56)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	openOK := b.condBranchPlaceholder(0xa) // GE
	openFailed := b.branchPlaceholder()
	if err := b.patchCondBranch(openOK, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.strRegSP(0, 248); err != nil {
		return nil, err
	}

	// write(fd, data, len)
	if err := b.ldrRegSP(1, 272); err != nil {
		return nil, err
	}
	if err := b.ldrRegSP(2, 280); err != nil {
		return nil, err
	}
	b.movImm64(8, 64)
	b.append(0xd4000001)
	b.cmpRegReg(0, 2)
	writeOK := b.condBranchPlaceholder(0x0) // EQ
	b.movImm64(17, 1)
	writeStatusDone := b.branchPlaceholder()
	if err := b.patchCondBranch(writeOK, len(b.words)); err != nil {
		return nil, err
	}
	b.movImm64(17, 0)
	if err := b.patchBranch(writeStatusDone, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.strRegSP(17, 240); err != nil {
		return nil, err
	}

	// close(fd); a close failure also reports helper failure.
	if err := b.ldrRegSP(0, 248); err != nil {
		return nil, err
	}
	b.movImm64(8, 57)
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	closeOK := b.condBranchPlaceholder(0xa)
	b.movImm64(17, 1)
	if err := b.strRegSP(17, 240); err != nil {
		return nil, err
	}
	if err := b.patchCondBranch(closeOK, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.ldrRegSP(0, 240); err != nil {
		return nil, err
	}
	done := b.branchPlaceholder()

	failure := len(b.words)
	for _, fixup := range []struct {
		index int
		cbz   bool
	}{
		{badPathEmpty, true}, {badPathLong, false}, {badPathOffset, false}, {badPathSpan, false},
		{badDataSpan, false},
	} {
		var err error
		if fixup.cbz {
			err = b.patchCBZ(fixup.index, failure)
		} else {
			err = b.patchCondBranch(fixup.index, failure)
		}
		if err != nil {
			return nil, err
		}
	}
	for _, pos := range dataFailures {
		if err := b.patchCondBranch(pos, failure); err != nil {
			return nil, err
		}
	}
	if err := b.patchBranch(openFailed, failure); err != nil {
		return nil, err
	}
	b.movImm64(0, 1)
	if err := b.patchBranch(done, len(b.words)); err != nil {
		return nil, err
	}
	if err := b.adjustSP(288); err != nil {
		return nil, err
	}
	b.ret()
	return dataFixups, nil
}

func buildARM64LinuxClockHelper() ([]byte, error) {
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-16); err != nil {
		return nil, err
	}
	b.movImm64(0, 1) // CLOCK_MONOTONIC
	if err := b.addRegSPAddress(1, 0); err != nil {
		return nil, err
	}
	b.movImm64(8, 113) // clock_gettime
	b.append(0xd4000001)
	b.cmpRegReg(0, 31)
	success := b.condBranchPlaceholder(0x0) // EQ
	b.movImm64(0, 0)
	b.movImm64(1, 1)
	doneFailure := b.branchPlaceholder()
	successOffset := len(b.words)
	if err := b.patchCondBranch(success, successOffset); err != nil {
		return nil, err
	}
	if err := b.ldrRegSP(0, 0); err != nil {
		return nil, err
	}
	if err := b.ldrRegSP(1, 8); err != nil {
		return nil, err
	}
	b.movImm64(2, 1_000_000_000)
	b.mul(0, 0, 2)
	b.addRegReg(0, 0, 1)
	b.movImm64(1, 0)
	done := len(b.words)
	if err := b.patchBranch(doneFailure, done); err != nil {
		return nil, err
	}
	if err := b.adjustSP(16); err != nil {
		return nil, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, nil
}

func emitARM64ProcessScalarText(b *arm64MachineBuilder, typ Type, bufferEndOffset int) error {
	if typ == IEEE64 {
		return emitARM64ProcessIEEE64HexText(b, bufferEndOffset)
	}
	if err := b.addRegSPAddress(7, bufferEndOffset); err != nil { // x7=end
		return err
	}
	if err := b.subRegImm(1, 7, 1); err != nil { // x1=current
		return err
	}
	b.movImm64(3, '\n')
	if err := b.strbRegBase(3, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}

	if typ == Bool {
		falseBranch := b.cbzPlaceholder(0)
		for _, ch := range []byte{'e', 'u', 'r', 't'} {
			b.movImm64(3, uint64(ch))
			if err := b.strbRegBase(3, 1, 0); err != nil {
				return err
			}
			if err := b.subRegImm(1, 1, 1); err != nil {
				return err
			}
		}
		doneTrue := b.branchPlaceholder()
		falseOffset := len(b.words)
		if err := b.patchCBZ(falseBranch, falseOffset); err != nil {
			return err
		}
		for _, ch := range []byte{'e', 's', 'l', 'a', 'f'} {
			b.movImm64(3, uint64(ch))
			if err := b.strbRegBase(3, 1, 0); err != nil {
				return err
			}
			if err := b.subRegImm(1, 1, 1); err != nil {
				return err
			}
		}
		if err := b.patchBranch(doneTrue, len(b.words)); err != nil {
			return err
		}
	} else {
		if typ != I64 && typ != U64 {
			return fmt.Errorf("arm64 process runtime: unsupported formatter type %s", typ)
		}
		b.movRegReg(3, 0) // magnitude
		b.movImm64(6, 0)  // sign
		if typ == I64 {
			b.cmpRegReg(3, 31)
			nonNegative := b.condBranchPlaceholder(0xa) // GE
			b.movImm64(6, 1)
			b.subRegReg(3, 31, 3)
			if err := b.patchCondBranch(nonNegative, len(b.words)); err != nil {
				return err
			}
		}
		b.movImm64(5, 10)
		digitLoop := len(b.words)
		b.movRegReg(4, 3) // original
		b.udiv(3, 3, 5)   // quotient
		b.mul(0, 3, 5)
		b.subRegReg(4, 4, 0) // remainder
		if err := b.addRegImm(4, 4, '0'); err != nil {
			return err
		}
		if err := b.strbRegBase(4, 1, 0); err != nil {
			return err
		}
		if err := b.subRegImm(1, 1, 1); err != nil {
			return err
		}
		moreDigits := b.cbzPlaceholder(3)
		back := b.branchPlaceholder()
		if err := b.patchBranch(back, digitLoop); err != nil {
			return err
		}
		if err := b.patchCBZ(moreDigits, len(b.words)); err != nil {
			return err
		}
		if typ == I64 {
			noSign := b.cbzPlaceholder(6)
			b.movImm64(4, '-')
			if err := b.strbRegBase(4, 1, 0); err != nil {
				return err
			}
			if err := b.subRegImm(1, 1, 1); err != nil {
				return err
			}
			if err := b.patchCBZ(noSign, len(b.words)); err != nil {
				return err
			}
		}
	}
	if err := b.addRegImm(1, 1, 1); err != nil {
		return err
	}
	b.subRegReg(2, 7, 1) // len=end-start
	return nil
}

func emitARM64ProcessIEEE64HexText(b *arm64MachineBuilder, bufferEndOffset int) error {
	// Canonical exact representation shared with x86-64:
	//   normal:    [-]0x1.<13hex>p+/-exp\n
	//   subnormal: [-]0x0.<13hex>p-1022\n
	//   zero:      [-]0x0p+0\n
	//   infinities: +/-inf\n
	//   NaN:       nan\n
	// Input raw bits arrive in x0.
	if err := b.addRegSPAddress(7, bufferEndOffset); err != nil {
		return err
	}
	if err := b.subRegImm(1, 7, 1); err != nil {
		return err
	}
	b.movImm64(3, '\n')
	if err := b.strbRegBase(3, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}

	b.movRegReg(10, 0)
	b.lsrImm(10, 10, 63) // number sign
	b.movRegReg(11, 0)
	b.lsrImm(11, 11, 52)
	b.movImm64(16, 0x7ff)
	b.logicalRegReg(0x8a000000, 11, 11, 16)
	b.movRegReg(12, 0)
	b.movImm64(16, 0x000fffffffffffff)
	b.logicalRegReg(0x8a000000, 12, 12, 16)

	b.movImm64(16, 0x7ff)
	b.cmpRegReg(11, 16)
	exponentMax := b.condBranchPlaceholder(0x0) // EQ
	exponentZero := b.cbzPlaceholder(11)

	// Normal finite.
	b.movRegReg(13, 11)
	if err := b.subRegImm(13, 13, 1023); err != nil {
		return err
	}
	if err := emitARM64HexFloatBody(b, '1'); err != nil {
		return err
	}
	normalDone := b.branchPlaceholder()

	// Exponent zero: zero or subnormal.
	zeroExpOffset := len(b.words)
	if err := b.patchCBZ(exponentZero, zeroExpOffset); err != nil {
		return err
	}
	zeroValue := b.cbzPlaceholder(12)
	b.movImm64(13, ^uint64(1021)) // int64(-1022) bit pattern
	if err := emitARM64HexFloatBody(b, '0'); err != nil {
		return err
	}
	subnormalDone := b.branchPlaceholder()

	zeroOffset := len(b.words)
	if err := b.patchCBZ(zeroValue, zeroOffset); err != nil {
		return err
	}
	if err := emitARM64WriteBackwardLiteral(b, "0x0p+0"); err != nil {
		return err
	}
	if err := emitARM64OptionalNegativeSign(b); err != nil {
		return err
	}
	zeroDone := b.branchPlaceholder()

	// Exponent all ones: infinity or NaN.
	maxOffset := len(b.words)
	if err := b.patchCondBranch(exponentMax, maxOffset); err != nil {
		return err
	}
	b.cmpRegReg(12, 31)
	nanValue := b.condBranchPlaceholder(0x1) // NE
	if err := emitARM64WriteBackwardLiteral(b, "inf"); err != nil {
		return err
	}
	if err := emitARM64OptionalNegativeSign(b); err != nil {
		return err
	}
	infDone := b.branchPlaceholder()
	nanOffset := len(b.words)
	if err := b.patchCondBranch(nanValue, nanOffset); err != nil {
		return err
	}
	if err := emitARM64WriteBackwardLiteral(b, "nan"); err != nil {
		return err
	}

	finalOffset := len(b.words)
	for _, pos := range []int{normalDone, subnormalDone, zeroDone, infDone} {
		if err := b.patchBranch(pos, finalOffset); err != nil {
			return err
		}
	}
	if err := b.addRegImm(1, 1, 1); err != nil {
		return err
	}
	b.subRegReg(2, 7, 1)
	return nil
}

func emitARM64HexFloatBody(b *arm64MachineBuilder, leading byte) error {
	// x13 signed exponent, x12 fraction, x10 number sign, x1 output cursor.
	b.movRegReg(15, 13)
	b.cmpRegReg(15, 31)
	nonNegative := b.condBranchPlaceholder(0x5) // PL
	b.subRegReg(15, 31, 15)
	b.movImm64(14, '-')
	expSignDone := b.branchPlaceholder()
	positiveOffset := len(b.words)
	if err := b.patchCondBranch(nonNegative, positiveOffset); err != nil {
		return err
	}
	b.movImm64(14, '+')
	if err := b.patchBranch(expSignDone, len(b.words)); err != nil {
		return err
	}

	b.movImm64(16, 10)
	expDigits := len(b.words)
	b.movRegReg(17, 15)
	b.udiv(15, 15, 16)
	b.mul(3, 15, 16)
	b.subRegReg(17, 17, 3)
	if err := b.addRegImm(17, 17, '0'); err != nil {
		return err
	}
	if err := b.strbRegBase(17, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}
	digitsDone := b.cbzPlaceholder(15)
	back := b.branchPlaceholder()
	if err := b.patchBranch(back, expDigits); err != nil {
		return err
	}
	if err := b.patchCBZ(digitsDone, len(b.words)); err != nil {
		return err
	}
	if err := b.strbRegBase(14, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}
	b.movImm64(3, 'p')
	if err := b.strbRegBase(3, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}

	b.movImm64(16, 0xf)
	for i := 0; i < 13; i++ {
		b.logicalRegReg(0x8a000000, 15, 12, 16)
		if err := b.cmpRegImm(15, 9); err != nil {
			return err
		}
		alpha := b.condBranchPlaceholder(0x8) // HI
		if err := b.addRegImm(15, 15, '0'); err != nil {
			return err
		}
		hexDone := b.branchPlaceholder()
		alphaOffset := len(b.words)
		if err := b.patchCondBranch(alpha, alphaOffset); err != nil {
			return err
		}
		if err := b.addRegImm(15, 15, 'a'-10); err != nil {
			return err
		}
		if err := b.patchBranch(hexDone, len(b.words)); err != nil {
			return err
		}
		if err := b.strbRegBase(15, 1, 0); err != nil {
			return err
		}
		if err := b.subRegImm(1, 1, 1); err != nil {
			return err
		}
		b.lsrImm(12, 12, 4)
	}
	for _, ch := range []byte{'.', leading, 'x', '0'} {
		b.movImm64(3, uint64(ch))
		if err := b.strbRegBase(3, 1, 0); err != nil {
			return err
		}
		if err := b.subRegImm(1, 1, 1); err != nil {
			return err
		}
	}
	return emitARM64OptionalNegativeSign(b)
}

func emitARM64OptionalNegativeSign(b *arm64MachineBuilder) error {
	noSign := b.cbzPlaceholder(10)
	b.movImm64(3, '-')
	if err := b.strbRegBase(3, 1, 0); err != nil {
		return err
	}
	if err := b.subRegImm(1, 1, 1); err != nil {
		return err
	}
	return b.patchCBZ(noSign, len(b.words))
}

func emitARM64WriteBackwardLiteral(b *arm64MachineBuilder, text string) error {
	for i := len(text) - 1; i >= 0; i-- {
		b.movImm64(3, uint64(text[i]))
		if err := b.strbRegBase(3, 1, 0); err != nil {
			return err
		}
		if err := b.subRegImm(1, 1, 1); err != nil {
			return err
		}
	}
	return nil
}

func buildARM64LinuxProcessHelper(stream string, typ Type) ([]byte, error) {
	b := &arm64MachineBuilder{}
	if err := b.adjustSP(-64); err != nil {
		return nil, err
	}
	if err := emitARM64ProcessScalarText(b, typ, 48); err != nil {
		return nil, err
	}
	fd := uint64(1)
	if stream == "stderr" {
		fd = 2
	}
	b.movImm64(0, fd)
	b.movImm64(8, 64) // Linux AArch64 write
	b.append(0xd4000001)
	b.cmpRegReg(0, 2)
	b.cset(0, 0x1) // NE => failure
	if err := b.adjustSP(64); err != nil {
		return nil, err
	}
	b.ret()
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, nil
}
