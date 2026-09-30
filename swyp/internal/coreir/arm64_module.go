package coreir

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

var arm64ModuleMagic = [8]byte{'S', 'W', 'A', '6', '4', 'V', '1', '\n'}

type ARM64ModuleHeader struct {
	Version    int    `json:"version"`
	ABI        string `json:"abi"`
	Entry      string `json:"entry"`
	Params     []Type `json:"params"`
	Result     Type   `json:"result"`
	CodeSHA256 string `json:"code_sha256"`
}

type ARM64Module struct {
	Header ARM64ModuleHeader
	Code   []byte
}

func NewARM64Module(f SSAFunction, code []byte) (ARM64Module, error) {
	return newARM64Module(f, code, ARM64LeafMachineABI)
}

func NewARM64CFGModule(f SSAFunction, code []byte) (ARM64Module, error) {
	abi := ARM64CFGMachineABI
	for _, t := range f.ValueTypes {
		if t == IEEE64 {
			abi = ARM64CFGMachineFPABI
			break
		}
	}
	return newARM64Module(f, code, abi)
}

func NewARM64CFGCallsModule(f SSAFunction, code []byte) (ARM64Module, error) {
	return newARM64Module(f, code, ARM64CFGMachineCallsABI)
}

func NewARM64CFGFPCallsModule(f SSAFunction, code []byte) (ARM64Module, error) {
	return newARM64Module(f, code, ARM64CFGMachineFPCallsABI)
}

func newARM64Module(f SSAFunction, code []byte, abi string) (ARM64Module, error) {
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return ARM64Module{}, fmt.Errorf("arm64 module: invalid code size %d", len(code))
	}
	params := make([]Type, len(f.Params))
	for i, value := range f.Params {
		params[i] = f.ValueTypes[value]
	}
	hash := sha256.Sum256(code)
	return ARM64Module{
		Header: ARM64ModuleHeader{
			Version:    1,
			ABI:        abi,
			Entry:      f.Name,
			Params:     params,
			Result:     f.Result,
			CodeSHA256: hex.EncodeToString(hash[:]),
		},
		Code: append([]byte(nil), code...),
	}, nil
}

func EncodeARM64Module(m ARM64Module) ([]byte, error) {
	if err := validateARM64ModuleHeader(m.Header); err != nil {
		return nil, err
	}
	if len(m.Code) == 0 || len(m.Code) > MaxARM64LeafCodeBytes || len(m.Code)%4 != 0 {
		return nil, fmt.Errorf("arm64 module: invalid code size")
	}
	hash := sha256.Sum256(m.Code)
	if hex.EncodeToString(hash[:]) != m.Header.CodeSHA256 {
		return nil, fmt.Errorf("arm64 module: code hash mismatch")
	}
	header, err := json.Marshal(m.Header)
	if err != nil {
		return nil, err
	}
	if len(header) > 64<<10 {
		return nil, fmt.Errorf("arm64 module: header too large")
	}
	var out bytes.Buffer
	out.Write(arm64ModuleMagic[:])
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(len(header)))
	out.Write(raw[:])
	out.Write(header)
	out.Write(m.Code)
	return out.Bytes(), nil
}

func DecodeARM64Module(data []byte) (ARM64Module, error) {
	if len(data) < 12 || !bytes.Equal(data[:8], arm64ModuleMagic[:]) {
		return ARM64Module{}, fmt.Errorf("arm64 module: bad magic")
	}
	headerLen := int(binary.LittleEndian.Uint32(data[8:12]))
	if headerLen <= 0 || headerLen > 64<<10 || 12+headerLen >= len(data) {
		return ARM64Module{}, fmt.Errorf("arm64 module: invalid header length")
	}
	var header ARM64ModuleHeader
	dec := json.NewDecoder(bytes.NewReader(data[12 : 12+headerLen]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&header); err != nil {
		return ARM64Module{}, fmt.Errorf("arm64 module: decode header: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return ARM64Module{}, fmt.Errorf("arm64 module: trailing header JSON")
	}
	code := append([]byte(nil), data[12+headerLen:]...)
	if err := validateARM64ModuleHeader(header); err != nil {
		return ARM64Module{}, err
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return ARM64Module{}, fmt.Errorf("arm64 module: invalid code size")
	}
	hash := sha256.Sum256(code)
	if hex.EncodeToString(hash[:]) != header.CodeSHA256 {
		return ARM64Module{}, fmt.Errorf("arm64 module: code hash mismatch")
	}
	return ARM64Module{Header: header, Code: code}, nil
}

func validateARM64ModuleHeader(header ARM64ModuleHeader) error {
	if header.Version != 1 ||
		(header.ABI != ARM64LeafMachineABI && header.ABI != ARM64CFGMachineABI && header.ABI != ARM64CFGMachineCallsABI && header.ABI != ARM64CFGMachineFPABI && header.ABI != ARM64CFGMachineFPCallsABI) {
		return fmt.Errorf("arm64 module: unsupported header")
	}
	if !validX64EntryName(header.Entry) {
		return fmt.Errorf("arm64 module: invalid entry name")
	}
	allowFP := header.ABI == ARM64CFGMachineFPABI || header.ABI == ARM64CFGMachineFPCallsABI
	gprParams, fpParams := 0, 0
	for _, t := range header.Params {
		if t == IEEE64 && allowFP {
			fpParams++
			continue
		}
		if t != I64 && t != U64 && t != Bool {
			return fmt.Errorf("arm64 module: unsupported parameter type %s", t)
		}
		gprParams++
	}
	if gprParams > 7 || fpParams > 8 {
		return fmt.Errorf("arm64 module: parameter registers exceeded")
	}
	if header.Result != I64 && header.Result != U64 && header.Result != Bool && !(allowFP && header.Result == IEEE64) {
		return fmt.Errorf("arm64 module: unsupported result type %s", header.Result)
	}
	hash, err := hex.DecodeString(header.CodeSHA256)
	if err != nil || len(hash) != sha256.Size {
		return fmt.Errorf("arm64 module: invalid code sha256")
	}
	return nil
}
