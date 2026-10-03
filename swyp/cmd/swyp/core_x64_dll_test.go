package main

import (
	"bytes"
	"debug/pe"
	"os"
	"path/filepath"
	"testing"
)

func TestCoreX64DLLCommandCreatesPEImage(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	dllPath := filepath.Join(dir, "add.dll")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64DLLCommand([]string{"-entry", "add", "-o", dllPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := pe.Open(dllPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || f.Section(".text") == nil || f.Section(".edata") == nil {
		t.Fatalf("machine=0x%x sections=%v", f.FileHeader.Machine, f.Sections)
	}
	if err := coreX64DLLCommand([]string{"-entry", "add", "-o", dllPath, source}, &out); err == nil {
		t.Fatal("core-x64-dll overwrote existing image")
	}
}
