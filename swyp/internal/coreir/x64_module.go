package coreir

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"unicode"
)

var x64ModuleMagic = [8]byte{'S', 'W', 'X', '6', '4', 'V', '1', '\n'}

type X64ModuleHeader struct {
	Version    int    `json:"version"`
	ABI        string `json:"abi"`
	Entry      string `json:"entry"`
	Params     []Type `json:"params"`
	Result     Type   `json:"result"`
	CodeSHA256 string `json:"code_sha256"`
}

type X64Module struct {
	Header X64ModuleHeader
	Code   []byte
}

func NewX64Module(f SSAFunction, code []byte) (X64Module, error) {
	return newX64Module(f, code, X64LeafABI)
}

func NewX64CFGModule(f SSAFunction, code []byte) (X64Module, error) {
	abi := X64CFGMachineABI
	for _, t := range f.ValueTypes {
		if t == IEEE64 {
			abi = X64CFGMachineFPABI
			break
		}
	}
	return newX64Module(f, code, abi)
}

func NewX64CFGCallsModule(f SSAFunction, code []byte) (X64Module, error) {
	return newX64Module(f, code, X64CFGMachineCallsABI)
}

func NewX64CFGFPCallsModule(f SSAFunction, code []byte) (X64Module, error) {
	return newX64Module(f, code, X64CFGMachineFPCallsABI)
}

func newX64Module(f SSAFunction, code []byte, abi string) (X64Module, error) {
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return X64Module{}, fmt.Errorf("x64 module: invalid code size %d", len(code))
	}
	params := make([]Type, len(f.Params))
	for i, value := range f.Params {
		params[i] = f.ValueTypes[value]
	}
	hash := sha256.Sum256(code)
	return X64Module{
		Header: X64ModuleHeader{
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

func EncodeX64Module(m X64Module) ([]byte, error) {
	if err := validateX64ModuleHeader(m.Header); err != nil {
		return nil, err
	}
	if len(m.Code) == 0 || len(m.Code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 module: invalid code size")
	}
	hash := sha256.Sum256(m.Code)
	if hex.EncodeToString(hash[:]) != m.Header.CodeSHA256 {
		return nil, fmt.Errorf("x64 module: code hash mismatch")
	}
	header, err := json.Marshal(m.Header)
	if err != nil {
		return nil, err
	}
	if len(header) > 64<<10 {
		return nil, fmt.Errorf("x64 module: header too large")
	}
	var out bytes.Buffer
	out.Write(x64ModuleMagic[:])
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], uint32(len(header)))
	out.Write(raw[:])
	out.Write(header)
	out.Write(m.Code)
	return out.Bytes(), nil
}

func DecodeX64Module(data []byte) (X64Module, error) {
	if len(data) < 12 || !bytes.Equal(data[:8], x64ModuleMagic[:]) {
		return X64Module{}, fmt.Errorf("x64 module: bad magic")
	}
	headerLen := int(binary.LittleEndian.Uint32(data[8:12]))
	if headerLen <= 0 || headerLen > 64<<10 || 12+headerLen >= len(data) {
		return X64Module{}, fmt.Errorf("x64 module: invalid header length")
	}
	var header X64ModuleHeader
	dec := json.NewDecoder(bytes.NewReader(data[12 : 12+headerLen]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&header); err != nil {
		return X64Module{}, fmt.Errorf("x64 module: decode header: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return X64Module{}, fmt.Errorf("x64 module: trailing header JSON")
	}
	code := append([]byte(nil), data[12+headerLen:]...)
	if err := validateX64ModuleHeader(header); err != nil {
		return X64Module{}, err
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return X64Module{}, fmt.Errorf("x64 module: invalid code size")
	}
	hash := sha256.Sum256(code)
	if hex.EncodeToString(hash[:]) != header.CodeSHA256 {
		return X64Module{}, fmt.Errorf("x64 module: code hash mismatch")
	}
	return X64Module{Header: header, Code: code}, nil
}

func validateX64ModuleHeader(header X64ModuleHeader) error {
	if header.Version != 1 ||
		(header.ABI != X64LeafABI && header.ABI != X64CFGMachineABI && header.ABI != X64CFGMachineCallsABI && header.ABI != X64CFGMachineFPABI && header.ABI != X64CFGMachineFPCallsABI && header.ABI != X64CFGABI) {
		return fmt.Errorf("x64 module: unsupported header")
	}
	if !validX64EntryName(header.Entry) {
		return fmt.Errorf("x64 module: invalid entry name")
	}
	if len(header.Params) > 4 {
		return fmt.Errorf("x64 module: too many parameters")
	}
	allowFP := header.ABI == X64CFGMachineFPABI || header.ABI == X64CFGMachineFPCallsABI
	for _, t := range header.Params {
		if t != I64 && t != U64 && t != Bool && !(allowFP && t == IEEE64) {
			return fmt.Errorf("x64 module: unsupported parameter type %s", t)
		}
	}
	if header.Result != I64 && header.Result != U64 && header.Result != Bool && !(allowFP && header.Result == IEEE64) {
		return fmt.Errorf("x64 module: unsupported result type %s", header.Result)
	}
	hash, err := hex.DecodeString(header.CodeSHA256)
	if err != nil || len(hash) != sha256.Size {
		return fmt.Errorf("x64 module: invalid code sha256")
	}
	return nil
}

func validX64EntryName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for i, r := range name {
		if r == '_' || unicode.IsLetter(r) || (i > 0 && unicode.IsDigit(r)) {
			continue
		}
		return false
	}
	return true
}
