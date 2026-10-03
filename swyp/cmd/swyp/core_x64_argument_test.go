package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func TestCoreX64HarnessRejectsInvalidTypedArguments(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	for _, tc := range []struct {
		typ     string
		valid   []string
		invalid []string
	}{
		{typ: "i64", valid: []string{"-9223372036854775808", "9223372036854775807", "+42"}, invalid: []string{"", "garbage", "42junk", " 42", "42 ", "9223372036854775808", "-9223372036854775809"}},
		{typ: "u64", valid: []string{"0", "18446744073709551615"}, invalid: []string{"", "-1", "+1", " 42", "42junk", "18446744073709551616"}},
		{typ: "bool", valid: []string{"true", "false", "1", "0"}, invalid: []string{"", "truthy", "2", "TRUE", " false"}},
		{typ: "ieee64", valid: []string{"1.5", "-2e3", "nan", "inf", "1e-300"}, invalid: []string{"", "1.5junk", " 1.5", "1.5 ", "1e9999"}},
	} {
		t.Run(tc.typ, func(t *testing.T) {
			dir := t.TempDir()
			source := filepath.Join(dir, "identity.swyp")
			executable := filepath.Join(dir, "identity.exe")
			program := "fn identity(x:" + tc.typ + ")->" + tc.typ + "{return x;} fn main(){}"
			if err := os.WriteFile(source, []byte(program), 0o600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			if err := coreX64BuildCommand([]string{"-entry", "identity", "-o", executable, source}, &output); err != nil {
				t.Fatal(err)
			}
			for _, arg := range tc.valid {
				if out, err := exec.Command(executable, arg).CombinedOutput(); err != nil {
					t.Fatalf("valid argument %s rejected: err=%v out=%q", strconv.Quote(arg), err, out)
				}
			}
			for _, arg := range tc.invalid {
				out, err := exec.Command(executable, arg).CombinedOutput()
				if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 2 || !bytes.Contains(out, []byte("invalid typed argument")) {
					t.Fatalf("invalid argument %s accepted or wrong diagnostic: err=%v out=%q", strconv.Quote(arg), err, out)
				}
			}
		})
	}
}
