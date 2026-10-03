package coreir

import (
	"fmt"
	"sort"
)

func x64ProcessHelperSpec(name string) (stream string, typ Type, ok bool) {
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
	case "__swyp_rt_storage_len_u64":
		return "storage_len", U64, true
	case "__swyp_rt_storage_capacity_u64":
		return "storage_capacity", U64, true
	case "__swyp_rt_storage_set_len_u64":
		return "storage_set_len", Void, true
	default:
		return "", "", false
	}
}

type x64ProcessDataFixup struct {
	DispPos int
	Target  processDataTarget
}

const (
	nativeStorageMaxBlocks       = 64
	nativeStorageHeaderBytes     = 16
	nativeStorageDescriptorBytes = 32
	nativeStoragePayloadOffset   = nativeStorageHeaderBytes + nativeStorageMaxBlocks*nativeStorageDescriptorBytes
)

// buildX64StorageHelper emits a small CRT-free helper over the standalone RW
// runtime-data section. IDs are opaque slot+1 values, descriptors are monotonic
// and never reused, and payload allocation is bump-only within a backend-bounded
// arena. Free invalidates a descriptor; it intentionally does not recycle the
// payload in v1, preserving stale-ID safety without introducing a free-list ABI.
// All safety failures return RDX=1 and never dereference outside the arena.
func buildX64StorageHelper(kind string, storageOffset, storageBytes int) ([]byte, x64ProcessDataFixup, error) {
	if storageOffset < 0 || storageBytes < nativeStoragePayloadOffset || storageOffset+storageBytes > MaxProcessRuntimeArenaBytes {
		return nil, x64ProcessDataFixup{}, fmt.Errorf("x64 storage runtime: invalid partition offset=%d bytes=%d", storageOffset, storageBytes)
	}
	b := &x64MachineBuilder{}
	runtimeDisp := b.leaRegRIPRel32(x64R10)
	if storageOffset != 0 {
		b.addRegImm32(x64R10, uint32(storageOffset))
	}
	fail := make([]int, 0, 8)
	descPtr := func(idReg, dstReg int) {
		b.movRegReg(dstReg, idReg)
		b.subRegImm8(dstReg, 1)
		b.imulRegImm8(dstReg, dstReg, nativeStorageDescriptorBytes)
		b.addRegImm32(dstReg, nativeStorageHeaderBytes)
		b.binaryRegReg(0x01, dstReg, x64R10)
	}
	validateID := func(idReg, descReg, scratchReg int) {
		b.testRegReg(idReg, idReg)
		fail = append(fail, b.jccRel32(0x4)) // JE
		b.cmpRegImm32(idReg, nativeStorageMaxBlocks)
		fail = append(fail, b.jccRel32(0x7)) // JA
		descPtr(idReg, descReg)
		b.movRegMemDisp32(scratchReg, descReg, 16)
		b.cmpRegImm8(scratchReg, 1)
		fail = append(fail, b.jccRel32(0x5)) // JNE
	}

	switch kind {
	case "storage_alloc":
		// RCX = element count. Native storage is u64-only today.
		capacityElems := uint64((storageBytes - nativeStoragePayloadOffset) / 8)
		if capacityElems > uint64(^uint32(0)) {
			return nil, x64ProcessDataFixup{}, fmt.Errorf("x64 storage runtime: capacity too large")
		}
		b.cmpRegImm32(x64RCX, uint32(capacityElems))
		fail = append(fail, b.jccRel32(0x7)) // JA
		b.movRegMemDisp32(x64R9, x64R10, 0)  // next id
		b.testRegReg(x64R9, x64R9)
		haveID := b.jccRel32(0x5) // JNE
		b.movRegImm64(x64R9, 1)
		patchX64Rel32(b.code, haveID, len(b.code))
		b.cmpRegImm32(x64R9, nativeStorageMaxBlocks)
		fail = append(fail, b.jccRel32(0x7)) // JA

		b.movRegMemDisp32(x64R11, x64R10, 8) // cursor
		b.testRegReg(x64R11, x64R11)
		haveCursor := b.jccRel32(0x5)
		b.movRegImm64(x64R11, nativeStoragePayloadOffset)
		patchX64Rel32(b.code, haveCursor, len(b.code))

		b.movRegReg(x64RAX, x64RCX)
		b.shlRegImm8(x64RAX, 3)
		b.movRegImm64(x64RDX, uint64(storageBytes))
		b.binaryRegReg(0x29, x64RDX, x64R11) // available
		b.cmpRegReg(x64RAX, x64RDX)
		fail = append(fail, b.jccRel32(0x7)) // JA

		descPtr(x64R9, x64RDX)
		b.movMemDisp32Reg(x64RDX, 0, x64R11)
		b.movMemDisp32Reg(x64RDX, 8, x64RCX)
		b.movRegImm64(x64R8, 1)
		b.movMemDisp32Reg(x64RDX, 16, x64R8)
		b.movMemDisp32Reg(x64RDX, 24, x64RCX)
		b.binaryRegReg(0x01, x64R11, x64RAX)
		b.movMemDisp32Reg(x64R10, 8, x64R11)
		b.addRegImm8(x64R9, 1)
		b.movMemDisp32Reg(x64R10, 0, x64R9)
		b.subRegImm8(x64R9, 1)
		b.movRegReg(x64RAX, x64R9)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_load":
		// RCX=id, RDX=index.
		validateID(x64RCX, x64R9, x64R8)
		b.movRegMemDisp32(x64R8, x64R9, 8)
		b.cmpRegReg(x64RDX, x64R8)
		fail = append(fail, b.jccRel32(0x3)) // JAE
		b.movRegMemDisp32(x64R11, x64R9, 0)
		b.shlRegImm8(x64RDX, 3)
		b.binaryRegReg(0x01, x64R11, x64RDX)
		b.binaryRegReg(0x01, x64R11, x64R10)
		b.movRegMemDisp32(x64RAX, x64R11, 0)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_store":
		// RCX=id, RDX=index, R8=value.
		b.movRegReg(x64R11, x64R8) // preserve value
		validateID(x64RCX, x64R9, x64RAX)
		b.movRegMemDisp32(x64RAX, x64R9, 8)
		b.cmpRegReg(x64RDX, x64RAX)
		fail = append(fail, b.jccRel32(0x3))
		b.movRegMemDisp32(x64RAX, x64R9, 0)
		b.shlRegImm8(x64RDX, 3)
		b.binaryRegReg(0x01, x64RAX, x64RDX)
		b.binaryRegReg(0x01, x64RAX, x64R10)
		b.movMemDisp32Reg(x64RAX, 0, x64R11)
		b.xorRegReg(x64RAX, x64RAX)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_free":
		validateID(x64RCX, x64R9, x64R8)
		b.xorRegReg(x64R8, x64R8)
		b.movMemDisp32Reg(x64R9, 16, x64R8)
		b.xorRegReg(x64RAX, x64RAX)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_len":
		validateID(x64RCX, x64R9, x64R8)
		b.movRegMemDisp32(x64RAX, x64R9, 24)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_capacity":
		validateID(x64RCX, x64R9, x64R8)
		b.movRegMemDisp32(x64RAX, x64R9, 8)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	case "storage_set_len":
		validateID(x64RCX, x64R9, x64R8)
		b.movRegMemDisp32(x64R8, x64R9, 8)
		b.cmpRegReg(x64RDX, x64R8)
		fail = append(fail, b.jccRel32(0x7))
		b.movMemDisp32Reg(x64R9, 24, x64RDX)
		b.xorRegReg(x64RAX, x64RAX)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	default:
		return nil, x64ProcessDataFixup{}, fmt.Errorf("x64 storage runtime: unknown helper kind %q", kind)
	}

	failureOffset := len(b.code)
	for _, pos := range fail {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	b.ret()
	return b.code, x64ProcessDataFixup{DispPos: runtimeDisp, Target: processDataRuntime}, nil
}

func x64ProcessHelpers(process X64ProcessMachineCode) ([]string, error) {
	seen := make(map[string]bool)
	for _, fixup := range process.RuntimeFixups {
		if !x64ProcessRuntimeHelper(fixup.Helper) {
			return nil, fmt.Errorf("x64 process runtime: unknown helper %q", fixup.Helper)
		}
		seen[fixup.Helper] = true
	}
	helpers := make([]string, 0, len(seen))
	for helper := range seen {
		helpers = append(helpers, helper)
	}
	sort.Strings(helpers)
	return helpers, nil
}

func patchX64ProcessRuntime(code []byte, fixups []X64ProcessRuntimeFixup, offsets map[string]int) error {
	for _, fixup := range fixups {
		target, ok := offsets[fixup.Helper]
		if !ok {
			return fmt.Errorf("x64 process runtime: unresolved helper %q", fixup.Helper)
		}
		if fixup.DispPos < 0 || fixup.DispPos+4 > len(code) {
			return fmt.Errorf("x64 process runtime: invalid rel32 position %d", fixup.DispPos)
		}
		patchX64Rel32(code, fixup.DispPos, target)
	}
	return nil
}

func resolveX64LinuxProcessRuntime(process X64ProcessMachineCode) ([]byte, []x64ProcessDataFixup, error) {
	helpers, err := x64ProcessHelpers(process)
	if err != nil {
		return nil, nil, err
	}
	code := append([]byte(nil), process.Code...)
	offsets := make(map[string]int, len(helpers))
	dataFixups := make([]x64ProcessDataFixup, 0)
	ioRuntimeBytes := process.RuntimeDataBytes - process.StorageDataBytes
	if ioRuntimeBytes < 0 {
		return nil, nil, fmt.Errorf("x64 process runtime: storage data exceeds runtime data")
	}
	for _, helper := range helpers {
		stream, typ, _ := x64ProcessHelperSpec(helper)
		offsets[helper] = len(code)
		var runtimeCode []byte
		if stream == "clock" {
			runtimeCode, err = buildX64LinuxClockHelper()
		} else if stream == "rng" {
			runtimeCode, err = buildX64LinuxRNGHelper()
		} else if stream == "fswrite" {
			var fixups []x64ProcessDataFixup
			runtimeCode, fixups, err = buildX64LinuxFSWriteHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += len(code)
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "fsread" {
			var fixups []x64ProcessDataFixup
			runtimeCode, fixups, err = buildX64LinuxFSReadHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += len(code)
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytesget" {
			var fixups []x64ProcessDataFixup
			runtimeCode, fixups, err = buildX64BytesGetHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += len(code)
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytessnapshot" {
			var fixup x64ProcessDataFixup
			runtimeCode, fixup, err = buildX64BytesFromStorageHelper(len(process.Data), ioRuntimeBytes, process.StorageDataBytes)
			fixup.DispPos += len(code)
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netconnect" {
			var fixup x64ProcessDataFixup
			runtimeCode, fixup, err = buildX64LinuxNetConnectHelper(len(process.Data))
			fixup.DispPos += len(code)
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netfetch" {
			var fixups []x64ProcessDataFixup
			runtimeCode, fixups, err = buildX64LinuxNetFetchHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += len(code)
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "storage_alloc" || stream == "storage_load" || stream == "storage_store" || stream == "storage_free" {
			var fixup x64ProcessDataFixup
			runtimeCode, fixup, err = buildX64StorageHelper(stream, process.RuntimeDataBytes-process.StorageDataBytes, process.StorageDataBytes)
			fixup.DispPos += len(code)
			dataFixups = append(dataFixups, fixup)
		} else {
			runtimeCode, err = buildX64LinuxProcessHelper(stream, typ)
		}
		if err != nil {
			return nil, nil, err
		}
		code = append(code, runtimeCode...)
	}
	if err := patchX64ProcessRuntime(code, process.RuntimeFixups, offsets); err != nil {
		return nil, nil, err
	}
	if len(code) > MaxX64LeafCodeBytes {
		return nil, nil, fmt.Errorf("x64 process runtime: code size exceeds limit")
	}
	return code, dataFixups, nil
}

func buildX64LinuxNetConnectHelper(arenaLen int) ([]byte, x64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes {
		return nil, x64ProcessDataFixup{}, fmt.Errorf("x64 linux net.connect: invalid arena size %d", arenaLen)
	}
	b := &x64MachineBuilder{}
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, 160)
	b.movMemDisp32Reg(x64RSP, 136, x64RCX) // host descriptor
	b.movMemDisp32Reg(x64RSP, 144, x64RDX) // port
	dataDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 128, x64R10)

	// Copy host descriptor to a small NUL-terminated buffer at rsp+32.
	b.movRegMemDisp32(x64RAX, x64RSP, 136)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badHostEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 15)
	badHostLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(arenaLen))
	b.cmpRegReg(x64R8, x64R11)
	badHostOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badHostSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, 128)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, 32)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Validate port and construct sockaddr_in at rsp+80.
	b.movRegMemDisp32(x64R10, x64RSP, 144)
	b.testRegReg(x64R10, x64R10)
	badPortZero := b.jccRel32(0x4)
	b.cmpRegImm32(x64R10, 65535)
	badPortHigh := b.jccRel32(0x7)
	b.leaRegMemDisp32(x64R11, x64RSP, 80)
	b.movRegImm64(x64RAX, 2)
	b.movMemByteReg(x64R11, x64RAX) // AF_INET low byte
	b.addRegImm8(x64R11, 1)
	b.xorRegReg(x64RAX, x64RAX)
	b.movMemByteReg(x64R11, x64RAX)
	b.addRegImm8(x64R11, 1)
	b.movRegReg(x64RAX, x64R10)
	b.shrRegImm8(x64RAX, 8)
	b.movMemByteReg(x64R11, x64RAX) // port high byte
	b.addRegImm8(x64R11, 1)
	b.movMemByteReg(x64R11, x64R10) // port low byte
	b.addRegImm8(x64R11, 1)         // now points at sin_addr

	// Parse dotted-decimal IPv4 into four network-order bytes.
	b.leaRegMemDisp32(x64R9, x64RSP, 32)
	parseFailures := make([]int, 0, 20)
	for octet := 0; octet < 4; octet++ {
		b.xorRegReg(x64R10, x64R10) // accumulator
		b.xorRegReg(x64RCX, x64RCX) // digit count
		loop := len(b.code)
		b.movzxRegByteMem(x64R8, x64R9)
		b.cmpRegImm8(x64R8, '0')
		below := b.jccRel32(0x2)
		b.cmpRegImm8(x64R8, '9')
		above := b.jccRel32(0x7)
		b.subRegImm8(x64R8, '0')
		b.imulRegImm8(x64R10, x64R10, 10)
		b.binaryRegReg(0x01, x64R10, x64R8)
		b.cmpRegImm32(x64R10, 255)
		parseFailures = append(parseFailures, b.jccRel32(0x7))
		b.addRegImm8(x64R9, 1)
		b.addRegImm8(x64RCX, 1)
		back := b.jmpRel32()
		patchX64Rel32(b.code, back, loop)
		delimiter := len(b.code)
		patchX64Rel32(b.code, below, delimiter)
		patchX64Rel32(b.code, above, delimiter)
		b.testRegReg(x64RCX, x64RCX)
		parseFailures = append(parseFailures, b.jccRel32(0x4))
		if octet < 3 {
			b.cmpRegImm8(x64R8, '.')
			parseFailures = append(parseFailures, b.jccRel32(0x5))
			b.addRegImm8(x64R9, 1)
		} else {
			b.testRegReg(x64R8, x64R8)
			parseFailures = append(parseFailures, b.jccRel32(0x5))
		}
		b.movMemByteReg(x64R11, x64R10)
		b.addRegImm8(x64R11, 1)
	}
	// Zero sin_zero bytes.
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 88, x64R10)

	// socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
	b.movRegImm64(x64RAX, 41)
	b.movRegImm64(x64RDI, 2)
	b.movRegImm64(x64RSI, 1)
	b.movRegImm64(x64RDX, 6)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	socketFailed := b.jccRel32(0x8) // JS
	b.movMemDisp32Reg(x64RSP, 120, x64RAX)

	// connect(fd,&sockaddr,16)
	b.movRegReg(x64RDI, x64RAX)
	b.leaRegMemDisp32(x64RSI, x64RSP, 80)
	b.movRegImm64(x64RDX, 16)
	b.movRegImm64(x64RAX, 42)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegImm64(x64R10, 0)
	b.cmpRegReg(x64RAX, x64R10)
	b.movRegImm64(x64R11, 0)
	b.setcc(x64R11, 0x4)
	b.movMemDisp32Reg(x64RSP, 112, x64R11)

	// close(fd), preserving bool result.
	b.movRegMemDisp32(x64RDI, x64RSP, 120)
	b.movRegImm64(x64RAX, 3)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegMemDisp32(x64RAX, x64RSP, 112)
	b.xorRegReg(x64RDX, x64RDX)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range []int{badHostEmpty, badHostLong, badHostOffset, badHostSpan, badPortZero, badPortHigh, socketFailed} {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	for _, pos := range parseFailures {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 160)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, x64ProcessDataFixup{DispPos: dataDisp, Target: processDataModule}, nil
}

func emitX64RuntimeLiteral(b *x64MachineBuilder, ptrReg, scratchReg int, text string) {
	for i := 0; i < len(text); i++ {
		b.movRegImm64(scratchReg, uint64(text[i]))
		b.movMemByteReg(ptrReg, scratchReg)
		b.addRegImm8(ptrReg, 1)
	}
}

func buildX64LinuxNetFetchHelper(moduleLen, runtimeDataBytes int) ([]byte, []x64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("x64 linux net.fetch: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
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
		pollfdSlot    = 2384
		oldFlagsSlot  = 2392
		socketErrSlot = 2400
		socklenSlot   = 2408
	)
	b := &x64MachineBuilder{}
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, frameBytes)
	b.movMemDisp32Reg(x64RSP, hostDesc, x64RCX)
	b.movMemDisp32Reg(x64RSP, portSlot, x64RDX)
	b.movMemDisp32Reg(x64RSP, pathDesc, x64R8)
	moduleDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, moduleBase, x64R10)
	runtimeDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, runtimeBase, x64R10)

	// Host must be a non-empty immutable IPv4 literal no longer than 15 bytes.
	b.movRegMemDisp32(x64RAX, x64RSP, hostDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badHostEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 15)
	badHostLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badHostOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badHostSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, hostBase)
	b.movRegReg(x64R9, x64RAX)
	hostCopyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	hostCopyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, hostCopyMore, hostCopyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Path is immutable ASCII, starts with '/', and is capped to keep the stack
	// request buffer bounded. Control/space/non-ASCII bytes fail closed.
	b.movRegMemDisp32(x64RAX, x64RSP, pathDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 2048)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movzxRegByteMem(x64R9, x64R10)
	b.cmpRegImm8(x64R9, '/')
	badPathRoot := b.jccRel32(0x5)
	b.movRegReg(x64R11, x64RAX)
	pathValidateLoop := len(b.code)
	b.movzxRegByteMem(x64R9, x64R10)
	b.cmpRegImm8(x64R9, 0x21)
	badPathLow := b.jccRel32(0x2)
	b.cmpRegImm8(x64R9, 0x7e)
	badPathHigh := b.jccRel32(0x7)
	b.addRegImm8(x64R10, 1)
	b.subRegImm8(x64R11, 1)
	b.testRegReg(x64R11, x64R11)
	pathValidateMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, pathValidateMore, pathValidateLoop)

	// Build: GET <path> HTTP/1.1\r\nHost: <ipv4>\r\nConnection: close\r\n\r\n
	b.leaRegMemDisp32(x64R11, x64RSP, requestBase)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, "GET ")
	b.movRegMemDisp32(x64RAX, x64RSP, pathDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movRegReg(x64R9, x64RAX)
	reqPathLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	reqPathMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, reqPathMore, reqPathLoop)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, " HTTP/1.1\r\nHost: ")
	b.leaRegMemDisp32(x64R10, x64RSP, hostBase)
	b.movRegMemDisp32(x64RAX, x64RSP, hostDesc)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegReg(x64R9, x64RAX)
	reqHostLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	reqHostMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, reqHostMore, reqHostLoop)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, "\r\nConnection: close\r\n\r\n")
	b.movRegReg(x64R10, x64R11)
	b.leaRegMemDisp32(x64R9, x64RSP, requestBase)
	b.binaryRegReg(0x29, x64R10, x64R9)
	b.movMemDisp32Reg(x64RSP, reqLenSlot, x64R10)

	// Validate port and construct sockaddr_in.
	b.movRegMemDisp32(x64R10, x64RSP, portSlot)
	b.testRegReg(x64R10, x64R10)
	badPortZero := b.jccRel32(0x4)
	b.cmpRegImm32(x64R10, 65535)
	badPortHigh := b.jccRel32(0x7)
	b.leaRegMemDisp32(x64R11, x64RSP, sockaddrBase)
	b.movRegImm64(x64RAX, 2)
	b.movMemByteReg(x64R11, x64RAX)
	b.addRegImm8(x64R11, 1)
	b.xorRegReg(x64RAX, x64RAX)
	b.movMemByteReg(x64R11, x64RAX)
	b.addRegImm8(x64R11, 1)
	b.movRegReg(x64RAX, x64R10)
	b.shrRegImm8(x64RAX, 8)
	b.movMemByteReg(x64R11, x64RAX)
	b.addRegImm8(x64R11, 1)
	b.movMemByteReg(x64R11, x64R10)
	b.addRegImm8(x64R11, 1)

	b.leaRegMemDisp32(x64R9, x64RSP, hostBase)
	parseFailures := make([]int, 0, 20)
	for octet := 0; octet < 4; octet++ {
		b.xorRegReg(x64R10, x64R10)
		b.xorRegReg(x64RCX, x64RCX)
		loop := len(b.code)
		b.movzxRegByteMem(x64R8, x64R9)
		b.cmpRegImm8(x64R8, '0')
		below := b.jccRel32(0x2)
		b.cmpRegImm8(x64R8, '9')
		above := b.jccRel32(0x7)
		b.subRegImm8(x64R8, '0')
		b.imulRegImm8(x64R10, x64R10, 10)
		b.binaryRegReg(0x01, x64R10, x64R8)
		b.cmpRegImm32(x64R10, 255)
		parseFailures = append(parseFailures, b.jccRel32(0x7))
		b.addRegImm8(x64R9, 1)
		b.addRegImm8(x64RCX, 1)
		back := b.jmpRel32()
		patchX64Rel32(b.code, back, loop)
		delimiter := len(b.code)
		patchX64Rel32(b.code, below, delimiter)
		patchX64Rel32(b.code, above, delimiter)
		b.testRegReg(x64RCX, x64RCX)
		parseFailures = append(parseFailures, b.jccRel32(0x4))
		if octet < 3 {
			b.cmpRegImm8(x64R8, '.')
			parseFailures = append(parseFailures, b.jccRel32(0x5))
			b.addRegImm8(x64R9, 1)
		} else {
			b.testRegReg(x64R8, x64R8)
			parseFailures = append(parseFailures, b.jccRel32(0x5))
		}
		b.movMemByteReg(x64R11, x64R10)
		b.addRegImm8(x64R11, 1)
	}
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, sockaddrBase+8, x64R10)

	// socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
	b.movRegImm64(x64RAX, 41)
	b.movRegImm64(x64RDI, 2)
	b.movRegImm64(x64RSI, 1)
	b.movRegImm64(x64RDX, 6)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	socketFailed := b.jccRel32(0x8)
	b.movMemDisp32Reg(x64RSP, fdSlot, x64RAX)

	postSocketFailures := make([]int, 0, 12)
	// Fixed 5s send/receive timeout. This bounds request/response IO; connect
	// remains subject to the kernel TCP connect policy in this v1 helper.
	b.movRegImm64(x64R10, 5)
	b.movMemDisp32Reg(x64RSP, timevalBase, x64R10)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, timevalBase+8, x64R10)
	for _, opt := range []uint64{20, 21} {
		b.movRegImm64(x64RAX, 54)
		b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
		b.movRegImm64(x64RSI, 1)
		b.movRegImm64(x64RDX, opt)
		b.leaRegMemDisp32(x64R10, x64RSP, timevalBase)
		b.movRegImm64(x64R8, 16)
		b.code = append(b.code, 0x0f, 0x05)
		b.testRegReg(x64RAX, x64RAX)
		postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))
	}

	// Make connect non-blocking so the complete connection phase is bounded.
	b.movRegImm64(x64RAX, 72) // fcntl
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64RSI, 3) // F_GETFL
	b.xorRegReg(x64RDX, x64RDX)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))
	b.movMemDisp32Reg(x64RSP, oldFlagsSlot, x64RAX)
	b.movRegReg(x64RDX, x64RAX)
	b.movRegImm64(x64R10, 0x800) // O_NONBLOCK
	b.binaryRegReg(0x09, x64RDX, x64R10)
	b.movRegImm64(x64RAX, 72)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64RSI, 4) // F_SETFL
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))

	// connect(fd,&sockaddr,16). EINPROGRESS is completed through ppoll with
	// a fixed five-second deadline, then SO_ERROR is checked explicitly.
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.leaRegMemDisp32(x64RSI, x64RSP, sockaddrBase)
	b.movRegImm64(x64RDX, 16)
	b.movRegImm64(x64RAX, 42)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	connectImmediate := b.jccRel32(0x4)
	b.movRegImm64(x64R10, ^uint64(114)) // -EINPROGRESS
	b.cmpRegReg(x64RAX, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	b.movRegMemDisp32(x64R10, x64RSP, fdSlot)
	b.movRegImm64(x64R11, uint64(4)<<32) // pollfd.events = POLLOUT
	b.binaryRegReg(0x09, x64R10, x64R11)
	b.movMemDisp32Reg(x64RSP, pollfdSlot, x64R10)
	b.leaRegMemDisp32(x64RDI, x64RSP, pollfdSlot)
	b.movRegImm64(x64RSI, 1)
	b.leaRegMemDisp32(x64RDX, x64RSP, timevalBase) // timespec {5s,0}
	b.xorRegReg(x64R10, x64R10)
	b.xorRegReg(x64R8, x64R8)
	b.movRegImm64(x64RAX, 271) // ppoll
	b.code = append(b.code, 0x0f, 0x05)
	b.cmpRegImm32(x64RAX, 1)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, socketErrSlot, x64R10)
	b.movRegImm64(x64R10, 4)
	b.movMemDisp32Reg(x64RSP, socklenSlot, x64R10)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64RSI, 1) // SOL_SOCKET
	b.movRegImm64(x64RDX, 4) // SO_ERROR
	b.leaRegMemDisp32(x64R10, x64RSP, socketErrSlot)
	b.leaRegMemDisp32(x64R8, x64RSP, socklenSlot)
	b.movRegImm64(x64RAX, 55) // getsockopt
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))
	b.movRegMemDisp32(x64R10, x64RSP, socketErrSlot)
	b.shlRegImm8(x64R10, 32)
	b.shrRegImm8(x64R10, 32)
	b.testRegReg(x64R10, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	connectComplete := len(b.code)
	patchX64Rel32(b.code, connectImmediate, connectComplete)
	// Restore the original blocking mode before bounded send/receive I/O.
	b.movRegImm64(x64RAX, 72)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64RSI, 4)
	b.movRegMemDisp32(x64RDX, x64RSP, oldFlagsSlot)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))

	// Send the request completely without allowing a peer close to raise SIGPIPE.
	b.leaRegMemDisp32(x64RSI, x64RSP, requestBase)
	b.movRegMemDisp32(x64RDX, x64RSP, reqLenSlot)
	writeLoop := len(b.code)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64R10, 0x4000) // MSG_NOSIGNAL
	b.xorRegReg(x64R8, x64R8)     // dest_addr = NULL on connected socket
	b.xorRegReg(x64R9, x64R9)     // addrlen = 0
	b.movRegImm64(x64RAX, 44)     // sendto
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))
	b.binaryRegReg(0x01, x64RSI, x64RAX)
	b.binaryRegReg(0x29, x64RDX, x64RAX)
	b.testRegReg(x64RDX, x64RDX)
	writeMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, writeMore, writeLoop)

	// Reserve the remaining runtime arena without committing the cursor yet.
	b.movRegMemDisp32(x64R10, x64RSP, runtimeBase)
	b.movRegMemDisp32(x64R11, x64R10, 0)
	b.movMemDisp32Reg(x64RSP, cursorSlot, x64R11)
	b.movRegImm64(x64R8, uint64(runtimeDataBytes-8))
	b.cmpRegReg(x64R11, x64R8)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x7))
	b.binaryRegReg(0x29, x64R8, x64R11)
	b.movMemDisp32Reg(x64RSP, remainSlot, x64R8)
	b.leaRegMemDisp32(x64R9, x64R10, 8)
	b.binaryRegReg(0x01, x64R9, x64R11)
	b.movMemDisp32Reg(x64RSP, respPtrSlot, x64R9)
	b.xorRegReg(x64R11, x64R11)
	b.movMemDisp32Reg(x64RSP, respLenSlot, x64R11)

	readLoop := len(b.code)
	b.movRegMemDisp32(x64RDX, x64RSP, remainSlot)
	b.testRegReg(x64RDX, x64RDX)
	noRemaining := b.jccRel32(0x4)
	b.movRegMemDisp32(x64RSI, x64RSP, respPtrSlot)
	b.movRegMemDisp32(x64R11, x64RSP, respLenSlot)
	b.binaryRegReg(0x01, x64RSI, x64R11)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.xorRegReg(x64RAX, x64RAX)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x8))
	readEOF := b.jccRel32(0x4)
	b.movRegMemDisp32(x64R11, x64RSP, respLenSlot)
	b.binaryRegReg(0x01, x64R11, x64RAX)
	b.movMemDisp32Reg(x64RSP, respLenSlot, x64R11)
	b.movRegMemDisp32(x64R10, x64RSP, remainSlot)
	b.binaryRegReg(0x29, x64R10, x64RAX)
	b.movMemDisp32Reg(x64RSP, remainSlot, x64R10)
	readBack := b.jmpRel32()
	patchX64Rel32(b.code, readBack, readLoop)

	// If the arena fills exactly, probe one extra byte. EOF means exact fit;
	// any byte or timeout/error is treated as bounded-response failure.
	overflowProbe := len(b.code)
	patchX64Rel32(b.code, noRemaining, overflowProbe)
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.leaRegMemDisp32(x64RSI, x64RSP, scratchBase)
	b.movRegImm64(x64RDX, 1)
	b.xorRegReg(x64RAX, x64RAX)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	success := len(b.code)
	patchX64Rel32(b.code, readEOF, success)
	b.movRegMemDisp32(x64R10, x64RSP, runtimeBase)
	b.movRegMemDisp32(x64R11, x64RSP, cursorSlot)
	b.movRegMemDisp32(x64R9, x64RSP, respLenSlot)
	b.movRegReg(x64R8, x64R11)
	b.binaryRegReg(0x01, x64R8, x64R9)
	b.movMemReg(x64R10, x64R8)
	b.movRegReg(x64RAX, x64R11)
	b.addRegImm32(x64RAX, uint32(moduleLen))
	b.shlRegImm8(x64RAX, 32)
	b.binaryRegReg(0x09, x64RAX, x64R9)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64RAX)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	closePath := b.jmpRel32()

	postSocketFailure := len(b.code)
	for _, pos := range postSocketFailures {
		patchX64Rel32(b.code, pos, postSocketFailure)
	}
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	patchX64Rel32(b.code, closePath, len(b.code))

	// close(fd) on every path after successful socket creation.
	b.movRegMemDisp32(x64RDI, x64RSP, fdSlot)
	b.movRegImm64(x64RAX, 3)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	closeOK := b.jccRel32(0x9) // JNS
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	patchX64Rel32(b.code, closeOK, len(b.code))
	b.movRegMemDisp32(x64RAX, x64RSP, resultSlot)
	b.movRegMemDisp32(x64RDX, x64RSP, statusSlot)
	done := b.jmpRel32()

	failure := len(b.code)
	for _, pos := range []int{badHostEmpty, badHostLong, badHostOffset, badHostSpan, badPathEmpty, badPathLong, badPathOffset, badPathSpan, badPathRoot, badPathLow, badPathHigh, badPortZero, badPortHigh, socketFailed} {
		patchX64Rel32(b.code, pos, failure)
	}
	for _, pos := range parseFailures {
		patchX64Rel32(b.code, pos, failure)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, frameBytes)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, []x64ProcessDataFixup{
		{DispPos: moduleDisp, Target: processDataModule},
		{DispPos: runtimeDisp, Target: processDataRuntime},
	}, nil
}

func resolveX64WindowsProcessRuntime(process X64ProcessMachineCode) ([]byte, []x64PEIATFixup, []x64ProcessDataFixup, error) {
	helpers, err := x64ProcessHelpers(process)
	if err != nil {
		return nil, nil, nil, err
	}
	code := append([]byte(nil), process.Code...)
	offsets := make(map[string]int, len(helpers))
	iatFixups := make([]x64PEIATFixup, 0, len(helpers)*2)
	dataFixups := make([]x64ProcessDataFixup, 0)
	ioRuntimeBytes := process.RuntimeDataBytes - process.StorageDataBytes
	if ioRuntimeBytes < 0 {
		return nil, nil, nil, fmt.Errorf("x64 process runtime: storage data exceeds runtime data")
	}
	for _, helper := range helpers {
		stream, typ, _ := x64ProcessHelperSpec(helper)
		base := len(code)
		offsets[helper] = base
		var runtimeCode []byte
		var helperIAT []x64PEIATFixup
		if stream == "clock" {
			runtimeCode, helperIAT, err = buildX64WindowsClockHelper()
		} else if stream == "rng" {
			runtimeCode, helperIAT, err = buildX64WindowsRNGHelper()
		} else if stream == "fswrite" {
			var fixups []x64ProcessDataFixup
			runtimeCode, helperIAT, fixups, err = buildX64WindowsFSWriteHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += base
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "fsread" {
			var helperIAT []x64PEIATFixup
			var fixups []x64ProcessDataFixup
			runtimeCode, helperIAT, fixups, err = buildX64WindowsFSReadHelper(len(process.Data), ioRuntimeBytes)
			for i := range helperIAT {
				helperIAT[i].dispPos += len(code)
			}
			iatFixups = append(iatFixups, helperIAT...)
			for _, fixup := range fixups {
				fixup.DispPos += len(code)
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytesget" {
			var fixups []x64ProcessDataFixup
			runtimeCode, fixups, err = buildX64BytesGetHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += base
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "bytessnapshot" {
			var fixup x64ProcessDataFixup
			runtimeCode, fixup, err = buildX64BytesFromStorageHelper(len(process.Data), ioRuntimeBytes, process.StorageDataBytes)
			fixup.DispPos += len(code)
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netconnect" {
			var fixup x64ProcessDataFixup
			runtimeCode, helperIAT, fixup, err = buildX64WindowsNetConnectHelper(len(process.Data))
			fixup.DispPos += base
			dataFixups = append(dataFixups, fixup)
		} else if stream == "netfetch" {
			var fixups []x64ProcessDataFixup
			runtimeCode, helperIAT, fixups, err = buildX64WindowsNetFetchHelper(len(process.Data), ioRuntimeBytes)
			for _, fixup := range fixups {
				fixup.DispPos += base
				dataFixups = append(dataFixups, fixup)
			}
		} else if stream == "storage_alloc" || stream == "storage_load" || stream == "storage_store" || stream == "storage_free" {
			var fixup x64ProcessDataFixup
			runtimeCode, fixup, err = buildX64StorageHelper(stream, process.RuntimeDataBytes-process.StorageDataBytes, process.StorageDataBytes)
			fixup.DispPos += base
			dataFixups = append(dataFixups, fixup)
		} else {
			runtimeCode, helperIAT, err = buildX64WindowsProcessHelper(stream, typ)
		}
		if err != nil {
			return nil, nil, nil, err
		}
		code = append(code, runtimeCode...)
		for _, fixup := range helperIAT {
			fixup.dispPos += base
			iatFixups = append(iatFixups, fixup)
		}
	}
	if err := patchX64ProcessRuntime(code, process.RuntimeFixups, offsets); err != nil {
		return nil, nil, nil, err
	}
	if len(code) > MaxX64LeafCodeBytes {
		return nil, nil, nil, fmt.Errorf("x64 process runtime: code size exceeds limit")
	}
	return code, iatFixups, dataFixups, nil
}

func buildX64BytesGetHelper(moduleLen, runtimeDataBytes int) ([]byte, []x64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes {
		return nil, nil, fmt.Errorf("x64 bytes.get: invalid module arena size %d", moduleLen)
	}
	if runtimeDataBytes < 0 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("x64 bytes.get: invalid runtime arena size %d", runtimeDataBytes)
	}
	b := &x64MachineBuilder{}
	fixups := make([]x64ProcessDataFixup, 0, 2)
	b.movRegReg(x64R9, x64RCX)
	b.shrRegImm8(x64R9, 32) // logical offset
	b.movRegReg(x64R10, x64RCX)
	b.shlRegImm8(x64R10, 32)
	b.shrRegImm8(x64R10, 32) // length
	b.cmpRegImm32(x64R9, uint32(moduleLen))
	runtimeBranch := b.jccRel32(0x3) // JAE

	// Immutable module arena.
	if moduleLen > 0 {
		moduleDisp := b.leaRegRIPRel32(x64R8)
		fixups = append(fixups, x64ProcessDataFixup{DispPos: moduleDisp, Target: processDataModule})
		b.movRegImm64(x64R11, uint64(moduleLen))
		b.movRegReg(x64RAX, x64R11)
		b.binaryRegReg(0x29, x64RAX, x64R9)
		b.cmpRegReg(x64R10, x64RAX)
		moduleBadSpan := b.jccRel32(0x7)
		b.cmpRegReg(x64RDX, x64R10)
		moduleBadIndex := b.jccRel32(0x3)
		b.binaryRegReg(0x01, x64R8, x64R9)
		b.binaryRegReg(0x01, x64R8, x64RDX)
		b.movzxRegByteMem(x64RAX, x64R8)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
		failurePlaceholder := len(b.code)
		_ = failurePlaceholder
		// Patch these after the runtime branch body has been emitted.
		fixups = append(fixups,
			x64ProcessDataFixup{DispPos: -moduleBadSpan - 1, Target: processDataModule},
			x64ProcessDataFixup{DispPos: -moduleBadIndex - 1, Target: processDataModule},
		)
	}

	runtimeOffset := len(b.code)
	patchX64Rel32(b.code, runtimeBranch, runtimeOffset)
	runtimeFailures := make([]int, 0, 4)
	if runtimeDataBytes >= 8 {
		runtimeDisp := b.leaRegRIPRel32(x64R8)
		fixups = append(fixups, x64ProcessDataFixup{DispPos: runtimeDisp, Target: processDataRuntime})
		b.movRegImm64(x64R11, uint64(moduleLen))
		b.binaryRegReg(0x29, x64R9, x64R11) // runtime payload offset
		b.movRegMemDisp32(x64RAX, x64R8, 0) // committed cursor
		b.cmpRegReg(x64R9, x64RAX)
		runtimeFailures = append(runtimeFailures, b.jccRel32(0x7))
		b.binaryRegReg(0x29, x64RAX, x64R9) // remaining committed bytes
		b.cmpRegReg(x64R10, x64RAX)
		runtimeFailures = append(runtimeFailures, b.jccRel32(0x7))
		b.cmpRegReg(x64RDX, x64R10)
		runtimeFailures = append(runtimeFailures, b.jccRel32(0x3))
		b.addRegImm8(x64R8, 8)
		b.binaryRegReg(0x01, x64R8, x64R9)
		b.binaryRegReg(0x01, x64R8, x64RDX)
		b.movzxRegByteMem(x64RAX, x64R8)
		b.xorRegReg(x64RDX, x64RDX)
		b.ret()
	}
	failure := len(b.code)
	for _, pos := range runtimeFailures {
		patchX64Rel32(b.code, pos, failure)
	}
	// Recover encoded module failure placeholders kept in the fixup slice.
	cleanFixups := make([]x64ProcessDataFixup, 0, 2)
	for _, fx := range fixups {
		if fx.DispPos < 0 {
			patchX64Rel32(b.code, -fx.DispPos-1, failure)
			continue
		}
		cleanFixups = append(cleanFixups, fx)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	b.ret()
	return b.code, cleanFixups, nil
}

func buildX64WindowsFSReadHelper(moduleLen, runtimeDataBytes int) ([]byte, []x64PEIATFixup, []x64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, nil, fmt.Errorf("x64 fs.read: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
	}
	b := &x64MachineBuilder{}
	b.subRegImm32(x64RSP, 424)
	b.movMemDisp32Reg(x64RSP, 360, x64RCX)
	moduleDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 328, x64R10)
	runtimeDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 336, x64R10)

	// Path descriptor from immutable module arena -> stack buffer at +80.
	b.movRegMemDisp32(x64RAX, x64RSP, 360)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 240)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, 328)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, 80)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, NORMAL, NULL).
	b.leaRegMemDisp32(x64RCX, x64RSP, 80)
	b.movRegImm64(x64RDX, 0x80000000)
	b.movRegImm64(x64R8, 1)
	b.xorRegReg(x64R9, x64R9)
	b.movRegImm64(x64R10, 3)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	b.movRegImm64(x64R10, 0x80)
	b.movMemDisp32Reg(x64RSP, 40, x64R10)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 48, x64R10)
	fixups := []x64PEIATFixup{{dispPos: appendX64RIPIndirectCall(b), name: "CreateFileA"}}
	b.movRegImm64(x64R10, ^uint64(0))
	b.cmpRegReg(x64RAX, x64R10)
	createFailed := b.jccRel32(0x4)
	b.movMemDisp32Reg(x64RSP, 368, x64RAX)

	// GetFileSizeEx(handle,&size64).
	b.movRegReg(x64RCX, x64RAX)
	b.leaRegMemDisp32(x64RDX, x64RSP, 376)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 376, x64R10)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "GetFileSizeEx"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	sizeFailed := b.jccRel32(0x4)
	b.movRegMemDisp32(x64R9, x64RSP, 376)

	// Allocate monotonically from runtime payload [base+8, base+runtimeDataBytes).
	b.movRegMemDisp32(x64R10, x64RSP, 336)
	b.movRegMemDisp32(x64R11, x64R10, 0) // old cursor
	b.movMemDisp32Reg(x64RSP, 384, x64R11)
	b.movRegImm64(x64R8, uint64(runtimeDataBytes-8))
	b.cmpRegReg(x64R11, x64R8)
	arenaBadCursor := b.jccRel32(0x7)
	b.binaryRegReg(0x29, x64R8, x64R11)
	b.cmpRegReg(x64R9, x64R8)
	arenaFull := b.jccRel32(0x7)
	b.leaRegMemDisp32(x64RDX, x64R10, 8)
	b.binaryRegReg(0x01, x64RDX, x64R11)
	b.movMemDisp32Reg(x64RSP, 392, x64RDX)

	// ReadFile(handle,dst,size,&read,NULL).
	b.movRegMemDisp32(x64RCX, x64RSP, 368)
	b.movRegMemDisp32(x64RDX, x64RSP, 392)
	b.movRegReg(x64R8, x64R9)
	b.leaRegMemDisp32(x64R9, x64RSP, 400)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 400, x64R10)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "ReadFile"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	readFailed := b.jccRel32(0x4)
	b.movRegMemDisp32(x64RAX, x64RSP, 400)
	b.movRegMemDisp32(x64R9, x64RSP, 376)
	b.cmpRegReg(x64RAX, x64R9)
	shortRead := b.jccRel32(0x5)

	// Commit cursor only after a complete read.
	b.movRegMemDisp32(x64R10, x64RSP, 336)
	b.movRegMemDisp32(x64R11, x64RSP, 384)
	b.binaryRegReg(0x01, x64R11, x64R9)
	b.movMemReg(x64R10, x64R11)

	// Descriptor = (moduleLen+oldCursor)<<32 | fileSize.
	b.movRegMemDisp32(x64RAX, x64RSP, 384)
	b.addRegImm32(x64RAX, uint32(moduleLen))
	b.shlRegImm8(x64RAX, 32)
	b.movRegMemDisp32(x64R9, x64RSP, 376)
	b.binaryRegReg(0x09, x64RAX, x64R9)
	b.movMemDisp32Reg(x64RSP, 408, x64RAX)
	b.xorRegReg(x64R11, x64R11)
	b.movMemDisp32Reg(x64RSP, 416, x64R11)
	closePath := b.jmpRel32()

	readFailureOffset := len(b.code)
	for _, pos := range []int{sizeFailed, arenaBadCursor, arenaFull, readFailed, shortRead} {
		patchX64Rel32(b.code, pos, readFailureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movMemDisp32Reg(x64RSP, 408, x64RAX)
	b.movRegImm64(x64R11, 1)
	b.movMemDisp32Reg(x64RSP, 416, x64R11)
	patchX64Rel32(b.code, closePath, len(b.code))
	b.movRegMemDisp32(x64RCX, x64RSP, 368)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "CloseHandle"})
	b.movRegMemDisp32(x64RAX, x64RSP, 408)
	b.movRegMemDisp32(x64RDX, x64RSP, 416)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range []int{badPathEmpty, badPathLong, badPathOffset, badPathSpan, createFailed} {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 424)
	b.ret()
	return b.code, fixups, []x64ProcessDataFixup{
		{DispPos: moduleDisp, Target: processDataModule},
		{DispPos: runtimeDisp, Target: processDataRuntime},
	}, nil
}

func buildX64LinuxFSReadHelper(moduleLen, runtimeDataBytes int) ([]byte, []x64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("x64 fs.read: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
	}
	b := &x64MachineBuilder{}
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, 336)
	b.movMemDisp32Reg(x64RSP, 304, x64RCX)
	moduleDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 280, x64R10)
	runtimeDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 288, x64R10)

	// Path descriptor -> NUL-terminated stack buffer.
	b.movRegMemDisp32(x64RAX, x64RSP, 304)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 240)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, 280)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movRegReg(x64R11, x64RSP)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// openat(AT_FDCWD,path,O_RDONLY,0)
	b.movRegImm64(x64RAX, 257)
	b.movRegImm64(x64RDI, ^uint64(99))
	b.movRegReg(x64RSI, x64RSP)
	b.xorRegReg(x64RDX, x64RDX)
	b.xorRegReg(x64R10, x64R10)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	openFailed := b.jccRel32(0x8) // JS
	b.movMemDisp32Reg(x64RSP, 312, x64RAX)

	// lseek(fd,0,SEEK_END)
	b.movRegReg(x64RDI, x64RAX)
	b.xorRegReg(x64RSI, x64RSI)
	b.movRegImm64(x64RDX, 2)
	b.movRegImm64(x64RAX, 8)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	sizeFailed := b.jccRel32(0x8)
	b.movMemDisp32Reg(x64RSP, 320, x64RAX)

	// Ensure capacity before reading.
	b.movRegMemDisp32(x64R10, x64RSP, 288)
	b.movRegMemDisp32(x64R11, x64R10, 0)
	b.movMemDisp32Reg(x64RSP, 296, x64R11)
	b.movRegImm64(x64R8, uint64(runtimeDataBytes-8))
	b.cmpRegReg(x64R11, x64R8)
	arenaBadCursor := b.jccRel32(0x7)
	b.binaryRegReg(0x29, x64R8, x64R11)
	b.movRegMemDisp32(x64R9, x64RSP, 320)
	b.cmpRegReg(x64R9, x64R8)
	arenaFull := b.jccRel32(0x7)

	// lseek(fd,0,SEEK_SET)
	b.movRegMemDisp32(x64RDI, x64RSP, 312)
	b.xorRegReg(x64RSI, x64RSI)
	b.xorRegReg(x64RDX, x64RDX)
	b.movRegImm64(x64RAX, 8)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	seekFailed := b.jccRel32(0x8)
	b.testRegReg(x64RAX, x64RAX)
	seekNonZero := b.jccRel32(0x5)

	// read(fd, runtime+8+cursor, size)
	b.movRegMemDisp32(x64R10, x64RSP, 288)
	b.leaRegMemDisp32(x64RSI, x64R10, 8)
	b.movRegMemDisp32(x64R11, x64RSP, 296)
	b.binaryRegReg(0x01, x64RSI, x64R11)
	b.movRegMemDisp32(x64RDX, x64RSP, 320)
	b.movRegMemDisp32(x64RDI, x64RSP, 312)
	b.xorRegReg(x64RAX, x64RAX)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegMemDisp32(x64R9, x64RSP, 320)
	b.cmpRegReg(x64RAX, x64R9)
	readFailed := b.jccRel32(0x5)

	// Commit cursor and descriptor.
	b.movRegMemDisp32(x64R10, x64RSP, 288)
	b.movRegMemDisp32(x64R11, x64RSP, 296)
	b.binaryRegReg(0x01, x64R11, x64R9)
	b.movMemReg(x64R10, x64R11)
	b.movRegMemDisp32(x64RAX, x64RSP, 296)
	b.addRegImm32(x64RAX, uint32(moduleLen))
	b.shlRegImm8(x64RAX, 32)
	b.binaryRegReg(0x09, x64RAX, x64R9)
	b.movMemDisp32Reg(x64RSP, 328, x64RAX)
	b.xorRegReg(x64R11, x64R11)
	b.movMemDisp32Reg(x64RSP, 304, x64R11)
	closePath := b.jmpRel32()

	readFailureOffset := len(b.code)
	for _, pos := range []int{sizeFailed, arenaBadCursor, arenaFull, seekFailed, seekNonZero, readFailed} {
		patchX64Rel32(b.code, pos, readFailureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movMemDisp32Reg(x64RSP, 328, x64RAX)
	b.movRegImm64(x64R11, 1)
	b.movMemDisp32Reg(x64RSP, 304, x64R11)
	patchX64Rel32(b.code, closePath, len(b.code))
	b.movRegMemDisp32(x64RDI, x64RSP, 312)
	b.movRegImm64(x64RAX, 3)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegMemDisp32(x64RAX, x64RSP, 328)
	b.movRegMemDisp32(x64RDX, x64RSP, 304)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range []int{badPathEmpty, badPathLong, badPathOffset, badPathSpan, openFailed} {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 336)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, []x64ProcessDataFixup{
		{DispPos: moduleDisp, Target: processDataModule},
		{DispPos: runtimeDisp, Target: processDataRuntime},
	}, nil
}

func buildX64WindowsFSWriteHelper(arenaLen, runtimeBytes int) ([]byte, []x64PEIATFixup, []x64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes || runtimeBytes < 0 || runtimeBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, nil, fmt.Errorf("x64 fs.write: invalid arena sizes %d/%d", arenaLen, runtimeBytes)
	}
	b := &x64MachineBuilder{}
	// Entry RSP is 8 mod 16; 392 bytes restores pre-call alignment and leaves
	// shadow/stack-arg space plus a 256-byte path buffer.
	b.subRegImm32(x64RSP, 392)
	b.movMemDisp32Reg(x64RSP, 360, x64RCX)
	b.movMemDisp32Reg(x64RSP, 368, x64RDX)
	dataDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 328, x64R10)

	// Decode path descriptor and copy at most 240 bytes to stack+80.
	b.movRegMemDisp32(x64RAX, x64RSP, 360)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 240)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(arenaLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, 80)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Resolve data descriptor to arena pointer/length.
	b.movRegMemDisp32(x64R10, x64RSP, 328)
	b.movRegMemDisp32(x64RAX, x64RSP, 368)
	dataFixups, dataFailures := b.emitFSWriteDataPointer(arenaLen, runtimeBytes)
	dataFixups = append(dataFixups, x64ProcessDataFixup{DispPos: dataDisp, Target: processDataModule})
	b.movMemDisp32Reg(x64RSP, 344, x64R10)
	b.movMemDisp32Reg(x64RSP, 352, x64RAX)

	// CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, NORMAL, NULL).
	b.leaRegMemDisp32(x64RCX, x64RSP, 80)
	b.movRegImm64(x64RDX, 0x40000000)
	b.xorRegReg(x64R8, x64R8)
	b.xorRegReg(x64R9, x64R9)
	b.movRegImm64(x64R10, 2)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	b.movRegImm64(x64R10, 0x80)
	b.movMemDisp32Reg(x64RSP, 40, x64R10)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 48, x64R10)
	fixups := []x64PEIATFixup{{dispPos: appendX64RIPIndirectCall(b), name: "CreateFileA"}}
	b.movRegImm64(x64R10, ^uint64(0))
	b.cmpRegReg(x64RAX, x64R10)
	createFailed := b.jccRel32(0x4)
	b.movMemDisp32Reg(x64RSP, 376, x64RAX)

	// WriteFile(handle, data, length, &written, NULL).
	b.movRegReg(x64RCX, x64RAX)
	b.movRegMemDisp32(x64RDX, x64RSP, 344)
	b.movRegMemDisp32(x64R8, x64RSP, 352)
	b.leaRegMemDisp32(x64R9, x64RSP, 336)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 336, x64R10)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "WriteFile"})
	// Win32 BOOL is a 32-bit return value. Do not rely on undefined upper RAX
	// bits left by the callee when deciding success/failure.
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	writeFailed := b.jccRel32(0x4)
	b.movRegMemDisp32(x64R10, x64RSP, 336)
	b.movRegMemDisp32(x64R11, x64RSP, 352)
	b.cmpRegReg(x64R10, x64R11)
	shortWrite := b.jccRel32(0x5)
	b.xorRegReg(x64R11, x64R11) // success flag 0
	b.movMemDisp32Reg(x64RSP, 320, x64R11)
	skipFailureFlag := b.jmpRel32()
	writeFailureOffset := len(b.code)
	patchX64Rel32(b.code, writeFailed, writeFailureOffset)
	patchX64Rel32(b.code, shortWrite, writeFailureOffset)
	b.movRegImm64(x64R11, 1)
	b.movMemDisp32Reg(x64RSP, 320, x64R11)
	patchX64Rel32(b.code, skipFailureFlag, len(b.code))
	b.movRegMemDisp32(x64RCX, x64RSP, 376)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "CloseHandle"})
	b.movRegMemDisp32(x64RAX, x64RSP, 320)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range append(dataFailures, badPathEmpty, badPathLong, badPathOffset, badPathSpan, createFailed) {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.movRegImm64(x64RAX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 392)
	b.ret()
	return b.code, fixups, dataFixups, nil
}

func buildX64WindowsNetConnectHelper(arenaLen int) ([]byte, []x64PEIATFixup, x64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes {
		return nil, nil, x64ProcessDataFixup{}, fmt.Errorf("x64 net.connect: invalid arena size %d", arenaLen)
	}
	b := &x64MachineBuilder{}
	// Entry RSP is 8 mod 16. 600 bytes restores Win64 pre-call alignment and
	// leaves space for shadow args, host text, sockaddr_in and WSADATA.
	b.subRegImm32(x64RSP, 600)
	b.movMemDisp32Reg(x64RSP, 576, x64RCX) // host descriptor
	b.movMemDisp32Reg(x64RSP, 584, x64RDX) // port
	dataDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 568, x64R10)

	// Host descriptor -> bounded NUL-terminated buffer at rsp+64.
	b.movRegMemDisp32(x64RAX, x64RSP, 576)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badHostEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 63)
	badHostLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(arenaLen))
	b.cmpRegReg(x64R8, x64R11)
	badHostOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badHostSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, 568)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, 64)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Port must fit a TCP sockaddr port and cannot be zero.
	b.movRegMemDisp32(x64R10, x64RSP, 584)
	b.testRegReg(x64R10, x64R10)
	badPortZero := b.jccRel32(0x4)
	b.cmpRegImm32(x64R10, 65535)
	badPortHigh := b.jccRel32(0x7)

	ws2 := "WS2_32.dll"
	fixups := make([]x64PEIATFixup, 0, 7)
	// WSAStartup(MAKEWORD(2,2), &WSADATA).
	b.movRegImm64(x64RCX, 0x0202)
	b.leaRegMemDisp32(x64RDX, x64RSP, 160)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "WSAStartup"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	wsaFailed := b.jccRel32(0x5)

	// socket(AF_INET, SOCK_STREAM, IPPROTO_TCP).
	b.movRegImm64(x64RCX, 2)
	b.movRegImm64(x64RDX, 1)
	b.movRegImm64(x64R8, 6)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "socket"})
	b.movRegImm64(x64R10, ^uint64(0))
	b.cmpRegReg(x64RAX, x64R10)
	socketFailed := b.jccRel32(0x4)
	b.movMemDisp32Reg(x64RSP, 552, x64RAX)

	// sockaddr_in at rsp+128. htons(port) supplies the network-order port.
	b.movRegMemDisp32(x64RCX, x64RSP, 584)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "htons"})
	b.shlRegImm8(x64RAX, 48)
	b.shrRegImm8(x64RAX, 48)
	b.shlRegImm8(x64RAX, 16)
	b.movRegImm64(x64R10, 2)
	b.binaryRegReg(0x09, x64RAX, x64R10)
	b.movMemDisp32Reg(x64RSP, 128, x64RAX)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 136, x64R10)

	// inet_pton(AF_INET, host, &sin_addr). Literal IPv4 only; no DNS.
	b.movRegImm64(x64RCX, 2)
	b.leaRegMemDisp32(x64RDX, x64RSP, 64)
	b.leaRegMemDisp32(x64R8, x64RSP, 132)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "inet_pton"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.cmpRegImm32(x64RAX, 1)
	invalidLiteral := b.jccRel32(0x5)

	// connect(socket,&addr,sizeof(sockaddr_in)). Connection refusal is a normal
	// bool false, not a backend failure.
	b.movRegMemDisp32(x64RCX, x64RSP, 552)
	b.leaRegMemDisp32(x64RDX, x64RSP, 128)
	b.movRegImm64(x64R8, 16)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "connect"})
	b.movRegImm64(x64R10, 0)
	b.cmpRegReg(x64RAX, x64R10)
	b.movRegImm64(x64R11, 0)
	b.setcc(x64R11, 0x4) // true only on connect return 0
	b.movMemDisp32Reg(x64RSP, 544, x64R11)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 536, x64R10) // status 0
	cleanupSocket := b.jmpRel32()

	invalidLiteralOffset := len(b.code)
	patchX64Rel32(b.code, invalidLiteral, invalidLiteralOffset)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 544, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, 536, x64R10)

	patchX64Rel32(b.code, cleanupSocket, len(b.code))
	b.movRegMemDisp32(x64RCX, x64RSP, 552)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "closesocket"})
	cleanupWSA := b.jmpRel32()

	socketFailureOffset := len(b.code)
	patchX64Rel32(b.code, socketFailed, socketFailureOffset)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 544, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, 536, x64R10)

	patchX64Rel32(b.code, cleanupWSA, len(b.code))
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "WSACleanup"})
	b.movRegMemDisp32(x64RAX, x64RSP, 544)
	b.movRegMemDisp32(x64RDX, x64RSP, 536)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range []int{badHostEmpty, badHostLong, badHostOffset, badHostSpan, badPortZero, badPortHigh, wsaFailed} {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 600)
	b.ret()
	return b.code, fixups, x64ProcessDataFixup{DispPos: dataDisp, Target: processDataModule}, nil
}

func buildX64WindowsNetFetchHelper(moduleLen, runtimeDataBytes int) ([]byte, []x64PEIATFixup, []x64ProcessDataFixup, error) {
	if moduleLen < 0 || moduleLen > MaxByteArenaBytes || runtimeDataBytes < 8 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, nil, fmt.Errorf("x64 windows net.fetch: invalid arena sizes module=%d runtime=%d", moduleLen, runtimeDataBytes)
	}
	const (
		frameBytes         = 3608
		requestBase        = 64
		hostBase           = 2240
		sockaddrBase       = 2272
		timeoutBase        = 2296
		scratchBase        = 2304
		wsaDataBase        = 2368
		hostDesc           = 3200
		portSlot           = 3208
		pathDesc           = 3216
		moduleBase         = 3224
		runtimeBase        = 3232
		socketSlot         = 3240
		cursorSlot         = 3248
		respLenSlot        = 3256
		respPtrSlot        = 3264
		reqLenSlot         = 3272
		resultSlot         = 3280
		statusSlot         = 3288
		remainSlot         = 3296
		reqPtrSlot         = 3304
		nonblockSlot       = 3312
		writeSetBase       = 3320
		exceptSetBase      = 3344
		connectTimevalBase = 3368
		socketErrSlot      = 3376
		socklenSlot        = 3384
	)
	b := &x64MachineBuilder{}
	b.subRegImm32(x64RSP, frameBytes)
	b.movMemDisp32Reg(x64RSP, hostDesc, x64RCX)
	b.movMemDisp32Reg(x64RSP, portSlot, x64RDX)
	b.movMemDisp32Reg(x64RSP, pathDesc, x64R8)
	moduleDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, moduleBase, x64R10)
	runtimeDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, runtimeBase, x64R10)

	// Immutable host descriptor -> NUL-terminated stack buffer.
	b.movRegMemDisp32(x64RAX, x64RSP, hostDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badHostEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 15)
	badHostLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badHostOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badHostSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.leaRegMemDisp32(x64R11, x64RSP, hostBase)
	b.movRegReg(x64R9, x64RAX)
	hostCopyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	hostCopyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, hostCopyMore, hostCopyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Immutable, visible-ASCII path beginning with '/'.
	b.movRegMemDisp32(x64RAX, x64RSP, pathDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 2048)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(moduleLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movzxRegByteMem(x64R9, x64R10)
	b.cmpRegImm8(x64R9, '/')
	badPathRoot := b.jccRel32(0x5)
	b.movRegReg(x64R11, x64RAX)
	pathValidateLoop := len(b.code)
	b.movzxRegByteMem(x64R9, x64R10)
	b.cmpRegImm8(x64R9, 0x21)
	badPathLow := b.jccRel32(0x2)
	b.cmpRegImm8(x64R9, 0x7e)
	badPathHigh := b.jccRel32(0x7)
	b.addRegImm8(x64R10, 1)
	b.subRegImm8(x64R11, 1)
	b.testRegReg(x64R11, x64R11)
	pathValidateMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, pathValidateMore, pathValidateLoop)

	// Build the exact plaintext HTTP/1.1 request in the bounded stack buffer.
	b.leaRegMemDisp32(x64R11, x64RSP, requestBase)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, "GET ")
	b.movRegMemDisp32(x64RAX, x64RSP, pathDesc)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegMemDisp32(x64R10, x64RSP, moduleBase)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movRegReg(x64R9, x64RAX)
	reqPathLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	reqPathMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, reqPathMore, reqPathLoop)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, " HTTP/1.1\r\nHost: ")
	b.leaRegMemDisp32(x64R10, x64RSP, hostBase)
	b.movRegMemDisp32(x64RAX, x64RSP, hostDesc)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegReg(x64R9, x64RAX)
	reqHostLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	reqHostMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, reqHostMore, reqHostLoop)
	emitX64RuntimeLiteral(b, x64R11, x64RAX, "\r\nConnection: close\r\n\r\n")
	b.movRegReg(x64R10, x64R11)
	b.leaRegMemDisp32(x64R9, x64RSP, requestBase)
	b.binaryRegReg(0x29, x64R10, x64R9)
	b.movMemDisp32Reg(x64RSP, reqLenSlot, x64R10)

	// Port validation happens before any authority-bearing Winsock call.
	b.movRegMemDisp32(x64R10, x64RSP, portSlot)
	b.testRegReg(x64R10, x64R10)
	badPortZero := b.jccRel32(0x4)
	b.cmpRegImm32(x64R10, 65535)
	badPortHigh := b.jccRel32(0x7)

	ws2 := "WS2_32.dll"
	fixups := make([]x64PEIATFixup, 0, 16)
	b.movRegImm64(x64RCX, 0x0202)
	b.leaRegMemDisp32(x64RDX, x64RSP, wsaDataBase)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "WSAStartup"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	wsaFailed := b.jccRel32(0x5)

	b.movRegImm64(x64RCX, 2)
	b.movRegImm64(x64RDX, 1)
	b.movRegImm64(x64R8, 6)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "socket"})
	b.movRegImm64(x64R10, ^uint64(0))
	b.cmpRegReg(x64RAX, x64R10)
	socketFailed := b.jccRel32(0x4)
	b.movMemDisp32Reg(x64RSP, socketSlot, x64RAX)

	postSocketFailures := make([]int, 0, 12)
	// 5 second send/receive timeouts.
	b.movRegImm64(x64R10, 5000)
	b.movMemDisp32Reg(x64RSP, timeoutBase, x64R10)
	for _, opt := range []uint64{0x1006, 0x1005} {
		b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
		b.movRegImm64(x64RDX, 0xffff)
		b.movRegImm64(x64R8, opt)
		b.leaRegMemDisp32(x64R9, x64RSP, timeoutBase)
		b.movRegImm64(x64R10, 4)
		b.movMemDisp32Reg(x64RSP, 32, x64R10)
		fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "setsockopt"})
		b.shlRegImm8(x64RAX, 32)
		b.shrRegImm8(x64RAX, 32)
		b.testRegReg(x64RAX, x64RAX)
		postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))
	}

	// sockaddr_in at stack; inet_pton enforces literal IPv4 and no DNS.
	b.movRegMemDisp32(x64RCX, x64RSP, portSlot)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "htons"})
	b.shlRegImm8(x64RAX, 48)
	b.shrRegImm8(x64RAX, 48)
	b.shlRegImm8(x64RAX, 16)
	b.movRegImm64(x64R10, 2)
	b.binaryRegReg(0x09, x64RAX, x64R10)
	b.movMemDisp32Reg(x64RSP, sockaddrBase, x64RAX)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, sockaddrBase+8, x64R10)
	b.movRegImm64(x64RCX, 2)
	b.leaRegMemDisp32(x64RDX, x64RSP, hostBase)
	b.leaRegMemDisp32(x64R8, x64RSP, sockaddrBase+4)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "inet_pton"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.cmpRegImm32(x64RAX, 1)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	// Bound connect independently from send/receive with a temporary
	// non-blocking socket and select(5s), then verify SO_ERROR.
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, nonblockSlot, x64R10)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.movRegImm64(x64RDX, 0x8004667e) // FIONBIO
	b.leaRegMemDisp32(x64R8, x64RSP, nonblockSlot)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "ioctlsocket"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.leaRegMemDisp32(x64RDX, x64RSP, sockaddrBase)
	b.movRegImm64(x64R8, 16)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "connect"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	connectImmediate := b.jccRel32(0x4)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "WSAGetLastError"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.cmpRegImm32(x64RAX, 10035) // WSAEWOULDBLOCK
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, writeSetBase, x64R10)
	b.movRegMemDisp32(x64R10, x64RSP, socketSlot)
	b.movMemDisp32Reg(x64RSP, writeSetBase+8, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, exceptSetBase, x64R10)
	b.movRegMemDisp32(x64R10, x64RSP, socketSlot)
	b.movMemDisp32Reg(x64RSP, exceptSetBase+8, x64R10)
	b.movRegImm64(x64R10, 5) // timeval {5,0}; LONG fields are 32-bit
	b.movMemDisp32Reg(x64RSP, connectTimevalBase, x64R10)
	b.xorRegReg(x64RCX, x64RCX) // nfds ignored by Winsock
	b.xorRegReg(x64RDX, x64RDX)
	b.leaRegMemDisp32(x64R8, x64RSP, writeSetBase)
	b.leaRegMemDisp32(x64R9, x64RSP, exceptSetBase)
	b.leaRegMemDisp32(x64R10, x64RSP, connectTimevalBase)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "select"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegImm64(x64R10, 0xffffffff)
	b.cmpRegReg(x64RAX, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))

	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, socketErrSlot, x64R10)
	b.movRegImm64(x64R10, 4)
	b.movMemDisp32Reg(x64RSP, socklenSlot, x64R10)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.movRegImm64(x64RDX, 0xffff) // SOL_SOCKET
	b.movRegImm64(x64R8, 0x1007)  // SO_ERROR
	b.leaRegMemDisp32(x64R9, x64RSP, socketErrSlot)
	b.leaRegMemDisp32(x64R10, x64RSP, socklenSlot)
	b.movMemDisp32Reg(x64RSP, 32, x64R10)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "getsockopt"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))
	b.movRegMemDisp32(x64R10, x64RSP, socketErrSlot)
	b.shlRegImm8(x64R10, 32)
	b.shrRegImm8(x64R10, 32)
	b.testRegReg(x64R10, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	connectComplete := len(b.code)
	patchX64Rel32(b.code, connectImmediate, connectComplete)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, nonblockSlot, x64R10)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.movRegImm64(x64RDX, 0x8004667e)
	b.leaRegMemDisp32(x64R8, x64RSP, nonblockSlot)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "ioctlsocket"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	// send() until the complete request is written.
	b.leaRegMemDisp32(x64R10, x64RSP, requestBase)
	b.movMemDisp32Reg(x64RSP, reqPtrSlot, x64R10)
	sendLoop := len(b.code)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.movRegMemDisp32(x64RDX, x64RSP, reqPtrSlot)
	b.movRegMemDisp32(x64R8, x64RSP, reqLenSlot)
	b.xorRegReg(x64R9, x64R9)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "send"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegImm64(x64R10, 0xffffffff)
	b.cmpRegReg(x64RAX, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))
	b.movRegMemDisp32(x64R10, x64RSP, reqPtrSlot)
	b.binaryRegReg(0x01, x64R10, x64RAX)
	b.movMemDisp32Reg(x64RSP, reqPtrSlot, x64R10)
	b.movRegMemDisp32(x64R10, x64RSP, reqLenSlot)
	b.binaryRegReg(0x29, x64R10, x64RAX)
	b.movMemDisp32Reg(x64RSP, reqLenSlot, x64R10)
	b.testRegReg(x64R10, x64R10)
	sendMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, sendMore, sendLoop)

	// Reserve the current arena tail. Commit only after a clean EOF.
	b.movRegMemDisp32(x64R10, x64RSP, runtimeBase)
	b.movRegMemDisp32(x64R11, x64R10, 0)
	b.movMemDisp32Reg(x64RSP, cursorSlot, x64R11)
	b.movRegImm64(x64R8, uint64(runtimeDataBytes-8))
	b.cmpRegReg(x64R11, x64R8)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x7))
	b.binaryRegReg(0x29, x64R8, x64R11)
	b.movMemDisp32Reg(x64RSP, remainSlot, x64R8)
	b.leaRegMemDisp32(x64R9, x64R10, 8)
	b.binaryRegReg(0x01, x64R9, x64R11)
	b.movMemDisp32Reg(x64RSP, respPtrSlot, x64R9)
	b.xorRegReg(x64R11, x64R11)
	b.movMemDisp32Reg(x64RSP, respLenSlot, x64R11)

	recvLoop := len(b.code)
	b.movRegMemDisp32(x64R8, x64RSP, remainSlot)
	b.testRegReg(x64R8, x64R8)
	noRemaining := b.jccRel32(0x4)
	b.movRegMemDisp32(x64RDX, x64RSP, respPtrSlot)
	b.movRegMemDisp32(x64R11, x64RSP, respLenSlot)
	b.binaryRegReg(0x01, x64RDX, x64R11)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.xorRegReg(x64R9, x64R9)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "recv"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.movRegImm64(x64R10, 0xffffffff)
	b.cmpRegReg(x64RAX, x64R10)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x4))
	b.testRegReg(x64RAX, x64RAX)
	recvEOF := b.jccRel32(0x4)
	b.movRegMemDisp32(x64R11, x64RSP, respLenSlot)
	b.binaryRegReg(0x01, x64R11, x64RAX)
	b.movMemDisp32Reg(x64RSP, respLenSlot, x64R11)
	b.movRegMemDisp32(x64R10, x64RSP, remainSlot)
	b.binaryRegReg(0x29, x64R10, x64RAX)
	b.movMemDisp32Reg(x64RSP, remainSlot, x64R10)
	recvBack := b.jmpRel32()
	patchX64Rel32(b.code, recvBack, recvLoop)

	overflowProbe := len(b.code)
	patchX64Rel32(b.code, noRemaining, overflowProbe)
	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	b.leaRegMemDisp32(x64RDX, x64RSP, scratchBase)
	b.movRegImm64(x64R8, 1)
	b.xorRegReg(x64R9, x64R9)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "recv"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	postSocketFailures = append(postSocketFailures, b.jccRel32(0x5))

	success := len(b.code)
	patchX64Rel32(b.code, recvEOF, success)
	b.movRegMemDisp32(x64R10, x64RSP, runtimeBase)
	b.movRegMemDisp32(x64R11, x64RSP, cursorSlot)
	b.movRegMemDisp32(x64R9, x64RSP, respLenSlot)
	b.movRegReg(x64R8, x64R11)
	b.binaryRegReg(0x01, x64R8, x64R9)
	b.movMemReg(x64R10, x64R8)
	b.movRegReg(x64RAX, x64R11)
	b.addRegImm32(x64RAX, uint32(moduleLen))
	b.shlRegImm8(x64RAX, 32)
	b.binaryRegReg(0x09, x64RAX, x64R9)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64RAX)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	closePath := b.jmpRel32()

	postSocketFailure := len(b.code)
	for _, pos := range postSocketFailures {
		patchX64Rel32(b.code, pos, postSocketFailure)
	}
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	patchX64Rel32(b.code, closePath, len(b.code))

	b.movRegMemDisp32(x64RCX, x64RSP, socketSlot)
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "closesocket"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	closeOK := b.jccRel32(0x4)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	patchX64Rel32(b.code, closeOK, len(b.code))
	cleanupWSA := b.jmpRel32()

	socketFailureOffset := len(b.code)
	patchX64Rel32(b.code, socketFailed, socketFailureOffset)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)

	patchX64Rel32(b.code, cleanupWSA, len(b.code))
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), dll: ws2, name: "WSACleanup"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	cleanupOK := b.jccRel32(0x4)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, resultSlot, x64R10)
	b.movRegImm64(x64R10, 1)
	b.movMemDisp32Reg(x64RSP, statusSlot, x64R10)
	patchX64Rel32(b.code, cleanupOK, len(b.code))
	b.movRegMemDisp32(x64RAX, x64RSP, resultSlot)
	b.movRegMemDisp32(x64RDX, x64RSP, statusSlot)
	done := b.jmpRel32()

	failure := len(b.code)
	for _, pos := range []int{badHostEmpty, badHostLong, badHostOffset, badHostSpan, badPathEmpty, badPathLong, badPathOffset, badPathSpan, badPathRoot, badPathLow, badPathHigh, badPortZero, badPortHigh, wsaFailed} {
		patchX64Rel32(b.code, pos, failure)
	}
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, frameBytes)
	b.ret()
	return b.code, fixups, []x64ProcessDataFixup{
		{DispPos: moduleDisp, Target: processDataModule},
		{DispPos: runtimeDisp, Target: processDataRuntime},
	}, nil
}

func buildX64LinuxFSWriteHelper(arenaLen, runtimeBytes int) ([]byte, []x64ProcessDataFixup, error) {
	if arenaLen < 0 || arenaLen > MaxByteArenaBytes || runtimeBytes < 0 || runtimeBytes > MaxProcessRuntimeArenaBytes {
		return nil, nil, fmt.Errorf("x64 fs.write: invalid arena sizes %d/%d", arenaLen, runtimeBytes)
	}
	b := &x64MachineBuilder{}
	// Preserve SysV syscall argument registers that are nonvolatile in Swyp's
	// internal Win64 ABI.
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, 304)
	b.movMemDisp32Reg(x64RSP, 280, x64RCX)
	b.movMemDisp32Reg(x64RSP, 288, x64RDX)
	dataDisp := b.leaRegRIPRel32(x64R10)
	b.movMemDisp32Reg(x64RSP, 256, x64R10)

	// Path descriptor -> NUL-terminated stack buffer.
	b.movRegMemDisp32(x64RAX, x64RSP, 280)
	b.movRegReg(x64R8, x64RAX)
	b.shrRegImm8(x64R8, 32)
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	badPathEmpty := b.jccRel32(0x4)
	b.cmpRegImm32(x64RAX, 240)
	badPathLong := b.jccRel32(0x7)
	b.movRegImm64(x64R11, uint64(arenaLen))
	b.cmpRegReg(x64R8, x64R11)
	badPathOffset := b.jccRel32(0x7)
	b.movRegReg(x64R9, x64R11)
	b.binaryRegReg(0x29, x64R9, x64R8)
	b.cmpRegReg(x64RAX, x64R9)
	badPathSpan := b.jccRel32(0x7)
	b.movRegMemDisp32(x64R10, x64RSP, 256)
	b.binaryRegReg(0x01, x64R10, x64R8)
	b.movRegReg(x64R11, x64RSP)
	b.movRegReg(x64R9, x64RAX)
	copyLoop := len(b.code)
	b.movzxRegByteMem(x64R8, x64R10)
	b.movMemByteReg(x64R11, x64R8)
	b.addRegImm8(x64R10, 1)
	b.addRegImm8(x64R11, 1)
	b.subRegImm8(x64R9, 1)
	b.testRegReg(x64R9, x64R9)
	copyMore := b.jccRel32(0x5)
	patchX64Rel32(b.code, copyMore, copyLoop)
	b.xorRegReg(x64R8, x64R8)
	b.movMemByteReg(x64R11, x64R8)

	// Data descriptor -> direct arena pointer/length.
	b.movRegMemDisp32(x64RAX, x64RSP, 288)
	b.movRegMemDisp32(x64R10, x64RSP, 256)
	dataFixups, dataFailures := b.emitFSWriteDataPointer(arenaLen, runtimeBytes)
	dataFixups = append(dataFixups, x64ProcessDataFixup{DispPos: dataDisp, Target: processDataModule})
	b.movMemDisp32Reg(x64RSP, 264, x64R10)
	b.movMemDisp32Reg(x64RSP, 272, x64RAX)

	// openat(AT_FDCWD, path, O_WRONLY|O_CREAT|O_TRUNC, 0644)
	b.movRegImm64(x64RAX, 257)
	b.movRegImm64(x64RDI, ^uint64(99)) // int64(-100)
	b.movRegReg(x64RSI, x64RSP)
	b.movRegImm64(x64RDX, 577)
	b.movRegImm64(x64R10, 0644)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	openOK := b.jccRel32(0x9) // JNS
	openFailureJump := b.jmpRel32()
	patchX64Rel32(b.code, openOK, len(b.code))
	b.movMemDisp32Reg(x64RSP, 296, x64RAX)

	// write(fd, data, len)
	b.movRegReg(x64RDI, x64RAX)
	b.movRegMemDisp32(x64RSI, x64RSP, 264)
	b.movRegMemDisp32(x64RDX, x64RSP, 272)
	b.movRegImm64(x64RAX, 1)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegMemDisp32(x64R10, x64RSP, 272)
	b.cmpRegReg(x64RAX, x64R10)
	b.movRegImm64(x64R11, 0)
	b.setcc(x64R11, 0x5) // write failure / short write
	b.movMemDisp32Reg(x64RSP, 248, x64R11)

	// close(fd), preserving prior write status.
	b.movRegMemDisp32(x64RDI, x64RSP, 296)
	b.movRegImm64(x64RAX, 3)
	b.code = append(b.code, 0x0f, 0x05)
	b.movRegMemDisp32(x64RAX, x64RSP, 248)
	done := b.jmpRel32()

	failureOffset := len(b.code)
	for _, pos := range append(dataFailures, badPathEmpty, badPathLong, badPathOffset, badPathSpan, openFailureJump) {
		patchX64Rel32(b.code, pos, failureOffset)
	}
	b.movRegImm64(x64RAX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 304)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, dataFixups, nil
}

func buildX64LinuxClockHelper() ([]byte, error) {
	b := &x64MachineBuilder{}
	b.push(x64RSI)
	b.subRegImm32(x64RSP, 16)
	b.movRegImm64(x64RAX, 228) // clock_gettime
	b.movRegImm64(x64RDI, 1)   // CLOCK_MONOTONIC
	b.movRegReg(x64RSI, x64RSP)
	b.code = append(b.code, 0x0f, 0x05)
	b.testRegReg(x64RAX, x64RAX)
	failure := b.jccRel32(0x5)
	b.movRegMemDisp32(x64RAX, x64RSP, 0)
	b.movRegMemDisp32(x64RDX, x64RSP, 8)
	b.movRegImm64(x64R10, 1_000_000_000)
	b.imulRegReg(x64RAX, x64R10)
	b.binaryRegReg(0x01, x64RAX, x64RDX)
	b.xorRegReg(x64RDX, x64RDX)
	done := b.jmpRel32()
	failureOffset := len(b.code)
	patchX64Rel32(b.code, failure, failureOffset)
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 16)
	b.pop(x64RSI)
	b.ret()
	return b.code, nil
}

func buildX64LinuxRNGHelper() ([]byte, error) {
	b := &x64MachineBuilder{}
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, 16)
	b.movRegImm64(x64RAX, 318) // getrandom
	b.movRegReg(x64RDI, x64RSP)
	b.movRegImm64(x64RSI, 8)
	b.xorRegReg(x64RDX, x64RDX)
	b.code = append(b.code, 0x0f, 0x05)
	b.cmpRegImm8(x64RAX, 8)
	failure := b.jccRel32(0x5) // JNE
	b.movRegMemDisp32(x64RAX, x64RSP, 0)
	b.xorRegReg(x64RDX, x64RDX)
	done := b.jmpRel32()
	failureOffset := len(b.code)
	patchX64Rel32(b.code, failure, failureOffset)
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 16)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, nil
}

func buildX64WindowsClockHelper() ([]byte, []x64PEIATFixup, error) {
	b := &x64MachineBuilder{}
	b.subRegImm32(x64RSP, 40)
	fixups := []x64PEIATFixup{{dispPos: appendX64RIPIndirectCall(b), name: "GetTickCount64"}}
	b.addRegImm32(x64RSP, 40)
	b.movRegImm64(x64R10, 1_000_000)
	b.imulRegReg(x64RAX, x64R10)
	b.xorRegReg(x64RDX, x64RDX)
	b.ret()
	return b.code, fixups, nil
}

func buildX64WindowsRNGHelper() ([]byte, []x64PEIATFixup, error) {
	b := &x64MachineBuilder{}
	b.subRegImm32(x64RSP, 56)
	b.xorRegReg(x64RCX, x64RCX) // NULL algorithm: system-preferred RNG
	b.leaRegMemDisp32(x64RDX, x64RSP, 40)
	b.movRegImm64(x64R8, 8)
	b.movRegImm64(x64R9, 2) // BCRYPT_USE_SYSTEM_PREFERRED_RNG
	fixups := []x64PEIATFixup{{dispPos: appendX64RIPIndirectCall(b), dll: "BCRYPT.dll", name: "BCryptGenRandom"}}
	// BCryptGenRandom returns a 32-bit NTSTATUS in EAX. Upper RAX bits are not
	// part of the ABI contract, so clear them before checking for STATUS_SUCCESS.
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	failure := b.jccRel32(0x5) // NTSTATUS != 0
	b.movRegMemDisp32(x64RAX, x64RSP, 40)
	b.xorRegReg(x64RDX, x64RDX)
	done := b.jmpRel32()
	failureOffset := len(b.code)
	patchX64Rel32(b.code, failure, failureOffset)
	b.xorRegReg(x64RAX, x64RAX)
	b.movRegImm64(x64RDX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 56)
	b.ret()
	return b.code, fixups, nil
}

func emitX64ProcessScalarText(b *x64MachineBuilder, typ Type, bufferEndOffset int) error {
	if typ == IEEE64 {
		return emitX64ProcessIEEE64HexText(b, bufferEndOffset)
	}
	b.leaRegMemDisp32(x64R8, x64RSP, int32(bufferEndOffset))
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, '\n')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)

	if typ == Bool {
		b.testRegReg(x64RCX, x64RCX)
		falseBranch := b.jccRel32(0x4) // JE
		for _, ch := range []byte{'e', 'u', 'r', 't'} {
			b.movRegImm64(x64RDX, uint64(ch))
			b.movMemByteReg(x64R8, x64RDX)
			b.subRegImm8(x64R8, 1)
		}
		doneTrue := b.jmpRel32()
		falseOffset := len(b.code)
		patchX64Rel32(b.code, falseBranch, falseOffset)
		for _, ch := range []byte{'e', 's', 'l', 'a', 'f'} {
			b.movRegImm64(x64RDX, uint64(ch))
			b.movMemByteReg(x64R8, x64RDX)
			b.subRegImm8(x64R8, 1)
		}
		patchX64Rel32(b.code, doneTrue, len(b.code))
	} else {
		if typ != I64 && typ != U64 {
			return fmt.Errorf("x64 process runtime: unsupported formatter type %s", typ)
		}
		b.movRegReg(x64RAX, x64RCX)
		b.xorRegReg(x64R11, x64R11) // sign flag
		if typ == I64 {
			b.testRegReg(x64RAX, x64RAX)
			nonNegative := b.jccRel32(0x9) // JNS
			b.movRegImm64(x64R11, 1)
			b.neg(x64RAX) // INT64_MIN intentionally wraps to magnitude 2^63
			patchX64Rel32(b.code, nonNegative, len(b.code))
		}
		b.movRegImm64(x64R10, 10)
		digitLoop := len(b.code)
		b.xorRegReg(x64RDX, x64RDX)
		b.divReg(x64R10)
		b.addRegImm8(x64RDX, '0')
		b.movMemByteReg(x64R8, x64RDX)
		b.subRegImm8(x64R8, 1)
		b.testRegReg(x64RAX, x64RAX)
		moreDigits := b.jccRel32(0x5)
		patchX64Rel32(b.code, moreDigits, digitLoop)
		if typ == I64 {
			b.testRegReg(x64R11, x64R11)
			noSign := b.jccRel32(0x4)
			b.movRegImm64(x64RDX, '-')
			b.movMemByteReg(x64R8, x64RDX)
			b.subRegImm8(x64R8, 1)
			patchX64Rel32(b.code, noSign, len(b.code))
		}
	}

	b.addRegImm8(x64R8, 1) // start pointer
	b.leaRegMemDisp32(x64R9, x64RSP, int32(bufferEndOffset))
	b.binaryRegReg(0x29, x64R9, x64R8) // length = end - start
	return nil
}

func emitX64ProcessIEEE64HexText(b *x64MachineBuilder, bufferEndOffset int) error {
	// Canonical exact representation:
	//   normal:    [-]0x1.<13hex>p+/-exp\n
	//   subnormal: [-]0x0.<13hex>p-1022\n
	//   zero:      [-]0x0p+0\n
	//   infinities: +/-inf\n
	//   NaN:       nan\n
	// Input raw bits arrive in RCX.
	b.leaRegMemDisp32(x64R8, x64RSP, int32(bufferEndOffset))
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, '\n')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)

	b.movRegReg(x64RAX, x64RCX)
	b.movRegReg(x64R11, x64RAX)
	b.shrRegImm8(x64R11, 63) // number sign
	b.movRegReg(x64R10, x64RAX)
	b.shrRegImm8(x64R10, 52)
	b.movRegImm64(x64RDX, 0x7ff)
	b.binaryRegReg(0x21, x64R10, x64RDX) // exponent bits
	b.movRegReg(x64RCX, x64RAX)
	b.movRegImm64(x64RDX, 0x000fffffffffffff)
	b.binaryRegReg(0x21, x64RCX, x64RDX) // fraction bits

	b.movRegImm64(x64RDX, 0x7ff)
	b.cmpRegReg(x64R10, x64RDX)
	exponentMax := b.jccRel32(0x4) // JE
	b.testRegReg(x64R10, x64R10)
	exponentZero := b.jccRel32(0x4)

	// Normal finite value.
	b.subRegImm32(x64R10, 1023)
	emitX64HexFloatBody(b, '1')
	normalDone := b.jmpRel32()

	// Exponent zero: either zero or subnormal.
	zeroExpOffset := len(b.code)
	patchX64Rel32(b.code, exponentZero, zeroExpOffset)
	b.testRegReg(x64RCX, x64RCX)
	zeroValue := b.jccRel32(0x4)
	b.movRegImm64(x64R10, ^uint64(1021)) // int64(-1022) bit pattern
	emitX64HexFloatBody(b, '0')
	subnormalDone := b.jmpRel32()

	zeroOffset := len(b.code)
	patchX64Rel32(b.code, zeroValue, zeroOffset)
	emitX64WriteBackwardLiteral(b, "0x0p+0")
	emitX64OptionalNegativeSign(b)
	zeroDone := b.jmpRel32()

	// Exponent all ones: infinity or NaN.
	maxOffset := len(b.code)
	patchX64Rel32(b.code, exponentMax, maxOffset)
	b.testRegReg(x64RCX, x64RCX)
	nanValue := b.jccRel32(0x5) // JNE
	emitX64WriteBackwardLiteral(b, "inf")
	emitX64OptionalNegativeSign(b)
	infDone := b.jmpRel32()
	nanOffset := len(b.code)
	patchX64Rel32(b.code, nanValue, nanOffset)
	emitX64WriteBackwardLiteral(b, "nan")

	finalOffset := len(b.code)
	for _, pos := range []int{normalDone, subnormalDone, zeroDone, infDone} {
		patchX64Rel32(b.code, pos, finalOffset)
	}
	b.addRegImm8(x64R8, 1)
	b.leaRegMemDisp32(x64R9, x64RSP, int32(bufferEndOffset))
	b.binaryRegReg(0x29, x64R9, x64R8) // length=end-start
	return nil
}

func emitX64HexFloatBody(b *x64MachineBuilder, leading byte) {
	// R10 holds signed exponent; RCX holds 52-bit fraction; R11 number sign.
	b.movRegReg(x64RAX, x64R10)
	b.testRegReg(x64RAX, x64RAX)
	nonNegative := b.jccRel32(0x9) // JNS
	b.neg(x64RAX)
	b.movRegImm64(x64R10, '-')
	expSignDone := b.jmpRel32()
	nonNegativeOffset := len(b.code)
	patchX64Rel32(b.code, nonNegative, nonNegativeOffset)
	b.movRegImm64(x64R10, '+')
	patchX64Rel32(b.code, expSignDone, len(b.code))

	b.movRegImm64(x64R9, 10)
	expDigits := len(b.code)
	b.xorRegReg(x64RDX, x64RDX)
	b.divReg(x64R9)
	b.addRegImm8(x64RDX, '0')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	b.testRegReg(x64RAX, x64RAX)
	moreDigits := b.jccRel32(0x5)
	patchX64Rel32(b.code, moreDigits, expDigits)
	b.movMemByteReg(x64R8, x64R10)
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, 'p')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)

	// Writing low nibbles first while moving the pointer backwards yields the
	// canonical most-significant-first 13-hex-digit fraction in memory.
	for i := 0; i < 13; i++ {
		b.movRegReg(x64RAX, x64RCX)
		b.movRegImm64(x64RDX, 0xf)
		b.binaryRegReg(0x21, x64RAX, x64RDX)
		b.cmpRegImm8(x64RAX, 9)
		alpha := b.jccRel32(0x7) // JA
		b.addRegImm8(x64RAX, '0')
		hexDone := b.jmpRel32()
		alphaOffset := len(b.code)
		patchX64Rel32(b.code, alpha, alphaOffset)
		b.addRegImm8(x64RAX, 'a'-10)
		patchX64Rel32(b.code, hexDone, len(b.code))
		b.movMemByteReg(x64R8, x64RAX)
		b.subRegImm8(x64R8, 1)
		b.shrRegImm8(x64RCX, 4)
	}
	b.movRegImm64(x64RDX, '.')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, uint64(leading))
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, 'x')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	b.movRegImm64(x64RDX, '0')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	emitX64OptionalNegativeSign(b)
}

func emitX64OptionalNegativeSign(b *x64MachineBuilder) {
	b.testRegReg(x64R11, x64R11)
	noSign := b.jccRel32(0x4)
	b.movRegImm64(x64RDX, '-')
	b.movMemByteReg(x64R8, x64RDX)
	b.subRegImm8(x64R8, 1)
	patchX64Rel32(b.code, noSign, len(b.code))
}

func emitX64WriteBackwardLiteral(b *x64MachineBuilder, text string) {
	for i := len(text) - 1; i >= 0; i-- {
		b.movRegImm64(x64RDX, uint64(text[i]))
		b.movMemByteReg(x64R8, x64RDX)
		b.subRegImm8(x64R8, 1)
	}
}

func buildX64LinuxProcessHelper(stream string, typ Type) ([]byte, error) {
	b := &x64MachineBuilder{}
	// RSI/RDI are nonvolatile under Swyp's internal Win64 ABI, but Linux syscall
	// uses them for buffer/fd, so preserve both explicitly.
	b.push(x64RSI)
	b.push(x64RDI)
	b.subRegImm32(x64RSP, 96)
	if err := emitX64ProcessScalarText(b, typ, 80); err != nil {
		return nil, err
	}
	b.movRegReg(x64RDX, x64R9)
	b.movRegReg(x64RSI, x64R8)
	fd := uint64(1)
	if stream == "stderr" {
		fd = 2
	}
	b.movRegImm64(x64RDI, fd)
	b.movRegImm64(x64RAX, 1) // Linux x86-64 write
	b.code = append(b.code, 0x0f, 0x05)
	b.cmpRegReg(x64RAX, x64RDX)
	b.movRegImm64(x64RAX, 0)
	b.setcc(x64RAX, 0x5) // SETNE => runtime failure
	b.addRegImm32(x64RSP, 96)
	b.pop(x64RDI)
	b.pop(x64RSI)
	b.ret()
	return b.code, nil
}

func buildX64WindowsProcessHelper(stream string, typ Type) ([]byte, []x64PEIATFixup, error) {
	b := &x64MachineBuilder{}
	// Entry RSP is 8 mod 16. 120 bytes restores 16-byte pre-CALL alignment and
	// provides shadow space, text buffer, saved pointer/length and WriteFile count.
	b.subRegImm32(x64RSP, 120)
	if err := emitX64ProcessScalarText(b, typ, 80); err != nil {
		return nil, nil, err
	}
	b.movMemDisp32Reg(x64RSP, 88, x64R8)
	b.movMemDisp32Reg(x64RSP, 96, x64R9)
	stdHandle := uint64(^uint64(10)) // (uint64)(int64)-11 = STD_OUTPUT_HANDLE
	if stream == "stderr" {
		stdHandle = ^uint64(11) // -12
	}
	b.movRegImm64(x64RCX, stdHandle)
	fixups := []x64PEIATFixup{{dispPos: appendX64RIPIndirectCall(b), name: "GetStdHandle"}}
	b.movRegReg(x64RCX, x64RAX)
	b.movRegMemDisp32(x64RDX, x64RSP, 88)
	b.movRegMemDisp32(x64R8, x64RSP, 96)
	b.leaRegMemDisp32(x64R9, x64RSP, 104)
	b.xorRegReg(x64R10, x64R10)
	b.movMemDisp32Reg(x64RSP, 104, x64R10) // WriteFile writes only a DWORD; zero upper qword bytes.
	b.movMemDisp32Reg(x64RSP, 32, x64R10)  // lpOverlapped = NULL
	fixups = append(fixups, x64PEIATFixup{dispPos: appendX64RIPIndirectCall(b), name: "WriteFile"})
	b.shlRegImm8(x64RAX, 32)
	b.shrRegImm8(x64RAX, 32)
	b.testRegReg(x64RAX, x64RAX)
	writeFailed := b.jccRel32(0x4)
	b.movRegMemDisp32(x64R10, x64RSP, 104)
	b.movRegMemDisp32(x64R11, x64RSP, 96)
	b.cmpRegReg(x64R10, x64R11)
	b.movRegImm64(x64RAX, 0)
	b.setcc(x64RAX, 0x5)
	done := b.jmpRel32()
	failureOffset := len(b.code)
	patchX64Rel32(b.code, writeFailed, failureOffset)
	b.movRegImm64(x64RAX, 1)
	patchX64Rel32(b.code, done, len(b.code))
	b.addRegImm32(x64RSP, 120)
	b.ret()
	return b.code, fixups, nil
}
