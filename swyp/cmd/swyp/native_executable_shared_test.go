package main

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestNativeCompilerHangHelper(t *testing.T) {
	if os.Getenv("SWYP_NATIVE_COMPILER_HANG_HELPER") != "1" {
		return
	}
	time.Sleep(time.Second)
}

func TestRunNativeCompilerEnforcesTimeout(t *testing.T) {
	t.Setenv("SWYP_NATIVE_COMPILER_HANG_HELPER", "1")
	_, err := runNativeCompilerWithTimeout(20*time.Millisecond, os.Args[0], "-test.run=^TestNativeCompilerHangHelper$")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error=%v", err)
	}
}
