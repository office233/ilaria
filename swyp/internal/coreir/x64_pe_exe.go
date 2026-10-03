package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	pe64ExeImageBase = uint64(0x140000000)
)

type x64PEIATFixup struct {
	dispPos int
	dll     string
	name    string
}

type x64PEImportSpec struct {
	dll  string
	name string
}

func x64PEImportDLL(dll string) string {
	if dll == "" {
		return "KERNEL32.dll"
	}
	return dll
}

func x64PEImportKey(dll, name string) string {
	return x64PEImportDLL(dll) + "!" + name
}

// EncodeX64PEExecutable emits a standalone PE32+ console executable around a
// packed Swyp entry. i64/u64/bool parameters are parsed directly from the ANSI
// Windows command line without a CRT. The Swyp result becomes the process exit
// code; backend status failures terminate with exit code 1 and argument errors
// with exit code 2. Imported APIs are called through RIP-relative IAT slots.
func EncodeX64PEExecutable(f SSAFunction, code []byte) ([]byte, error) {
	return encodeX64PEExecutable(f, code, nil, nil, nil, 0)
}

func EncodeX64PEProcessExecutable(f SSAFunction, process X64ProcessMachineCode) ([]byte, error) {
	code, runtimeIAT, dataFixups, err := resolveX64WindowsProcessRuntime(process)
	if err != nil {
		return nil, err
	}
	return encodeX64PEExecutable(f, code, runtimeIAT, process.Data, dataFixups, process.RuntimeDataBytes)
}

func encodeX64PEExecutable(f SSAFunction, code []byte, runtimeIAT []x64PEIATFixup, rodata []byte, dataFixups []x64ProcessDataFixup, runtimeDataBytes int) ([]byte, error) {
	if !validX64EntryName(f.Name) {
		return nil, fmt.Errorf("x64 pe exe: invalid entry name")
	}
	if err := validateX64ExecutableSignature(f); err != nil {
		return nil, fmt.Errorf("x64 pe exe: %w", err)
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 pe exe: invalid code size %d", len(code))
	}
	if runtimeDataBytes < 0 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, fmt.Errorf("x64 pe exe: invalid runtime data size %d", runtimeDataBytes)
	}

	imports := []x64PEImportSpec{{name: "ExitProcess"}}
	if len(f.Params) != 0 {
		imports = append(imports, x64PEImportSpec{name: "GetCommandLineA"})
	}
	seenImport := make(map[string]bool, len(imports)+len(runtimeIAT))
	for _, spec := range imports {
		seenImport[x64PEImportKey(spec.dll, spec.name)] = true
	}
	for _, fixup := range runtimeIAT {
		key := x64PEImportKey(fixup.dll, fixup.name)
		if !seenImport[key] {
			seenImport[key] = true
			imports = append(imports, x64PEImportSpec{dll: fixup.dll, name: fixup.name})
		}
	}
	text, iatFixups, err := makeX64PEExecutableText(f, code, runtimeIAT)
	if err != nil {
		return nil, err
	}
	rdataRVA := 0
	afterTextRVA := pe64TextRVA + len(text)
	if len(rodata) != 0 {
		rdataRVA = alignObject(afterTextRVA, pe64SectionAlignment)
		afterTextRVA = rdataRVA + len(rodata)
	}
	runtimeDataRVA := 0
	if runtimeDataBytes != 0 {
		runtimeDataRVA = alignObject(afterTextRVA, pe64SectionAlignment)
		afterTextRVA = runtimeDataRVA + runtimeDataBytes
	}
	innerOffset := len(text) - len(code)
	for _, fixup := range dataFixups {
		dispPos := innerOffset + fixup.DispPos
		if dispPos < 0 || dispPos+4 > len(text) {
			return nil, fmt.Errorf("x64 pe exe: data fixup outside text")
		}
		targetRVA := rdataRVA
		label := "rdata"
		if fixup.Target == processDataRuntime {
			targetRVA = runtimeDataRVA
			label = "runtime data"
		}
		if targetRVA == 0 {
			return nil, fmt.Errorf("x64 pe exe: %s fixup without section", label)
		}
		nextRVA := pe64TextRVA + dispPos + 4
		rel := int64(targetRVA) - int64(nextRVA)
		if rel < -(1<<31) || rel >= 1<<31 {
			return nil, fmt.Errorf("x64 pe exe: %s displacement out of range", label)
		}
		binary.LittleEndian.PutUint32(text[dispPos:dispPos+4], uint32(int32(rel)))
	}
	importRVA := alignObject(afterTextRVA, pe64SectionAlignment)
	idata, iatOffsets, importDirectorySize, iatStart, iatSize := makeX64PEImports(importRVA, imports)
	relocRVA := alignObject(importRVA+len(idata), pe64SectionAlignment)
	for _, fixup := range iatFixups {
		offset, ok := iatOffsets[x64PEImportKey(fixup.dll, fixup.name)]
		if !ok {
			return nil, fmt.Errorf("x64 pe exe: missing IAT slot for %s", fixup.name)
		}
		iatRVA := importRVA + offset
		nextRVA := pe64TextRVA + fixup.dispPos + 4
		rel := int64(iatRVA) - int64(nextRVA)
		if rel < -(1<<31) || rel >= 1<<31 {
			return nil, fmt.Errorf("x64 pe exe: IAT call displacement out of range")
		}
		binary.LittleEndian.PutUint32(text[fixup.dispPos:fixup.dispPos+4], uint32(int32(rel)))
	}

	reloc := makeX64PEReloc(pe64ExeImageBase, relocRVA)
	textRawSize := alignObject(len(text), pe64FileAlignment)
	rdataRawSize := 0
	if len(rodata) != 0 {
		rdataRawSize = alignObject(len(rodata), pe64FileAlignment)
	}
	runtimeDataRawSize := 0
	if runtimeDataBytes != 0 {
		runtimeDataRawSize = alignObject(runtimeDataBytes, pe64FileAlignment)
	}
	idataRawSize := alignObject(len(idata), pe64FileAlignment)
	relocRawSize := alignObject(len(reloc), pe64FileAlignment)
	sectionCount := 3
	if len(rodata) != 0 {
		sectionCount = 4
	}
	if runtimeDataBytes != 0 {
		sectionCount++
	}
	peHeaderOff := pe64SignatureOffset
	fileHeaderOff := peHeaderOff + 4
	optionalOff := fileHeaderOff + 20
	sectionOff := optionalOff + pe64OptionalSize
	headerSize := alignObject(sectionOff+sectionCount*40, pe64FileAlignment)
	textRawOff := headerSize
	rdataRawOff := textRawOff + textRawSize
	runtimeDataRawOff := rdataRawOff + rdataRawSize
	idataRawOff := runtimeDataRawOff + runtimeDataRawSize
	relocRawOff := idataRawOff + idataRawSize
	imageSize := alignObject(relocRVA+len(reloc), pe64SectionAlignment)
	out := make([]byte, relocRawOff+relocRawSize)

	out[0], out[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(out[0x3c:0x40], uint32(peHeaderOff))
	copy(out[peHeaderOff:peHeaderOff+4], []byte{'P', 'E', 0, 0})
	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }

	put16(fileHeaderOff, coffAMD64Machine)
	put16(fileHeaderOff+2, uint16(sectionCount))
	put16(fileHeaderOff+16, pe64OptionalSize)
	put16(fileHeaderOff+18, 0x0022) // executable | large-address-aware

	put16(optionalOff, 0x20b)
	out[optionalOff+2] = 1
	put32(optionalOff+4, uint32(textRawSize))
	put32(optionalOff+8, uint32(rdataRawSize+runtimeDataRawSize+idataRawSize+relocRawSize))
	put32(optionalOff+16, pe64TextRVA)
	put32(optionalOff+20, pe64TextRVA)
	put64(optionalOff+24, pe64ExeImageBase)
	put32(optionalOff+32, pe64SectionAlignment)
	put32(optionalOff+36, pe64FileAlignment)
	put16(optionalOff+40, 6)
	put16(optionalOff+48, 6)
	put32(optionalOff+56, uint32(imageSize))
	put32(optionalOff+60, uint32(headerSize))
	put16(optionalOff+68, 3)
	put16(optionalOff+70, 0x0160) // HIGH_ENTROPY_VA | DYNAMIC_BASE | NX_COMPAT
	put64(optionalOff+72, 1<<20)
	put64(optionalOff+80, 1<<12)
	put64(optionalOff+88, 1<<20)
	put64(optionalOff+96, 1<<12)
	put32(optionalOff+108, 16)
	// Import directory.
	put32(optionalOff+120, uint32(importRVA))
	put32(optionalOff+124, uint32(importDirectorySize))
	// Base relocation directory.
	put32(optionalOff+152, uint32(relocRVA))
	put32(optionalOff+156, pe64RelocDirectorySize)
	// IAT directory.
	put32(optionalOff+208, uint32(importRVA+iatStart))
	put32(optionalOff+212, uint32(iatSize))

	writeSection := func(off int, name string, virtualSize, virtualAddress, rawSize, rawOff, characteristics uint32) {
		copy(out[off:off+8], []byte(name))
		put32(off+8, virtualSize)
		put32(off+12, virtualAddress)
		put32(off+16, rawSize)
		put32(off+20, rawOff)
		put32(off+36, characteristics)
	}
	writeSection(sectionOff, ".text", uint32(len(text)), pe64TextRVA, uint32(textRawSize), uint32(textRawOff), 0x60000020)
	sectionCursor := sectionOff + 40
	if len(rodata) != 0 {
		writeSection(sectionCursor, ".rdata", uint32(len(rodata)), uint32(rdataRVA), uint32(rdataRawSize), uint32(rdataRawOff), 0x40000040)
		sectionCursor += 40
	}
	if runtimeDataBytes != 0 {
		writeSection(sectionCursor, ".data", uint32(runtimeDataBytes), uint32(runtimeDataRVA), uint32(runtimeDataRawSize), uint32(runtimeDataRawOff), 0xc0000040)
		sectionCursor += 40
	}
	writeSection(sectionCursor, ".idata", uint32(len(idata)), uint32(importRVA), uint32(idataRawSize), uint32(idataRawOff), 0xc0000040)
	writeSection(sectionCursor+40, ".reloc", uint32(len(reloc)), uint32(relocRVA), uint32(relocRawSize), uint32(relocRawOff), 0x42000040)
	copy(out[textRawOff:], text)
	if len(rodata) != 0 {
		copy(out[rdataRawOff:], rodata)
	}
	copy(out[idataRawOff:], idata)
	copy(out[relocRawOff:], reloc)
	return out, nil
}

func makeX64PEExecutableText(f SSAFunction, inner []byte, innerIAT []x64PEIATFixup) ([]byte, []x64PEIATFixup, error) {
	b := &x64MachineBuilder{}
	// Windows enters the image with function-call style stack alignment. A
	// 104-byte frame preserves alignment while providing shadow space, staged
	// args and a private status cell.
	b.subRegImm32(x64RSP, 104)
	iatFixups := make([]x64PEIATFixup, 0, 3)
	argumentFailures := make([]int, 0)
	if len(f.Params) != 0 {
		getCommandLine := appendX64RIPIndirectCall(b)
		iatFixups = append(iatFixups, x64PEIATFixup{dispPos: getCommandLine, name: "GetCommandLineA"})
		b.movRegReg(x64RSI, x64RAX)
		argumentFailures = append(argumentFailures, emitX64SkipWindowsProgramName(b)...)
		for i, value := range f.Params {
			fixups, err := emitX64ParseScalarArg(b, f.ValueTypes[value], true)
			if err != nil {
				return nil, nil, err
			}
			argumentFailures = append(argumentFailures, fixups...)
			b.movMemDisp32Reg(x64RSP, int32(x64ExeArgBaseOffset+i*8), x64RAX)
			emitX64SkipCommandWhitespace(b)
		}
		b.movzxRegByteMem(x64RDX, x64RSI)
		b.testRegReg(x64RDX, x64RDX)
		argumentFailures = append(argumentFailures, b.jccRel32(0x5)) // extra argument/content
	}
	emitX64StageWin64ExecutableArgs(b, f)
	innerCall := b.callRel32()
	b.movRegMemDisp32(x64R10, x64RSP, x64ExeStatusOffset)
	b.testRegReg(x64R10, x64R10)
	failureJump := b.jccRel32(0x5) // JNE
	b.movRegReg(x64RCX, x64RAX)
	successIAT := appendX64RIPIndirectCall(b)
	iatFixups = append(iatFixups, x64PEIATFixup{dispPos: successIAT, name: "ExitProcess"})
	b.addRegImm32(x64RSP, 104)
	b.ret()
	backendFailureOffset := len(b.code)
	b.movRegImm64(x64RCX, 1)
	failureIAT := appendX64RIPIndirectCall(b)
	iatFixups = append(iatFixups, x64PEIATFixup{dispPos: failureIAT, name: "ExitProcess"})
	b.addRegImm32(x64RSP, 104)
	b.ret()
	argumentFailureOffset := len(b.code)
	b.movRegImm64(x64RCX, 2)
	argumentFailureIAT := appendX64RIPIndirectCall(b)
	iatFixups = append(iatFixups, x64PEIATFixup{dispPos: argumentFailureIAT, name: "ExitProcess"})
	b.addRegImm32(x64RSP, 104)
	b.ret()
	innerOffset := len(b.code)
	text := append(append([]byte(nil), b.code...), inner...)
	for _, fixup := range innerIAT {
		fixup.dispPos += innerOffset
		iatFixups = append(iatFixups, fixup)
	}
	patchX64Rel32(text, innerCall, innerOffset)
	patchX64Rel32(text, failureJump, backendFailureOffset)
	for _, pos := range argumentFailures {
		patchX64Rel32(text, pos, argumentFailureOffset)
	}
	return text, iatFixups, nil
}

func appendX64RIPIndirectCall(b *x64MachineBuilder) int {
	b.code = append(b.code, 0xff, 0x15)
	pos := len(b.code)
	b.code = append(b.code, 0, 0, 0, 0)
	return pos
}

func makeX64PEImports(baseRVA int, imports []x64PEImportSpec) ([]byte, map[string]int, int, int, int) {
	type group struct {
		dll        string
		functions  []string
		iltOff     int
		iatOff     int
		dllNameOff int
		hintOffs   []int
	}
	groupsByDLL := make(map[string]*group)
	order := make([]string, 0)
	for _, spec := range imports {
		dll := x64PEImportDLL(spec.dll)
		g := groupsByDLL[dll]
		if g == nil {
			g = &group{dll: dll}
			groupsByDLL[dll] = g
			order = append(order, dll)
		}
		g.functions = append(g.functions, spec.name)
	}
	descriptorBytes := (len(order) + 1) * 20
	cursor := alignObject(descriptorBytes, 8)
	for _, dll := range order {
		g := groupsByDLL[dll]
		thunkBytes := (len(g.functions) + 1) * 8
		g.iltOff = cursor
		cursor += thunkBytes
		g.iatOff = cursor
		cursor += thunkBytes
	}
	for _, dll := range order {
		g := groupsByDLL[dll]
		g.dllNameOff = cursor
		cursor += len(g.dll) + 1
		cursor = alignObject(cursor, 2)
		g.hintOffs = make([]int, len(g.functions))
		for i, name := range g.functions {
			g.hintOffs[i] = cursor
			cursor += 2 + len(name) + 1
			cursor = alignObject(cursor, 2)
		}
	}
	idata := make([]byte, cursor)
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(idata[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(idata[off:off+8], v) }
	iatOffsets := make(map[string]int, len(imports))
	for gi, dll := range order {
		g := groupsByDLL[dll]
		desc := gi * 20
		put32(desc, uint32(baseRVA+g.iltOff))
		put32(desc+12, uint32(baseRVA+g.dllNameOff))
		put32(desc+16, uint32(baseRVA+g.iatOff))
		copy(idata[g.dllNameOff:], []byte(g.dll))
		for i, name := range g.functions {
			rva := uint64(baseRVA + g.hintOffs[i])
			put64(g.iltOff+i*8, rva)
			put64(g.iatOff+i*8, rva)
			copy(idata[g.hintOffs[i]+2:], []byte(name))
			iatOffsets[x64PEImportKey(g.dll, name)] = g.iatOff + i*8
		}
	}
	iatStart := -1
	iatEnd := 0
	for _, dll := range order {
		g := groupsByDLL[dll]
		if iatStart < 0 || g.iatOff < iatStart {
			iatStart = g.iatOff
		}
		end := g.iatOff + (len(g.functions)+1)*8
		if end > iatEnd {
			iatEnd = end
		}
	}
	if iatStart < 0 {
		iatStart = 0
	}
	return idata, iatOffsets, descriptorBytes, iatStart, iatEnd - iatStart
}
