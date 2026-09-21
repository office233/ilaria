package swe

import (
	"context"
	"testing"
	"time"
)

func TestRunGo_PassingTest(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{
		"add.go":      "package sandbox\n\nfunc Add(a, b int) int { return a + b }\n",
		"add_test.go": "package sandbox\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 2) != 4 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n",
	})
	if err != nil {
		t.Fatalf("RunGo error: %v", err)
	}
	if !res.Success || res.TestsPassed != 1 || res.TestsFailed != 0 || res.TimedOut {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestRunGo_CompileError(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{
		"broken.go": "package sandbox\n\nfunc Broken() int { return \"x\" }\n",
	})
	if err != nil {
		t.Fatalf("RunGo error: %v", err)
	}
	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if len(res.Diagnostics) == 0 {
		t.Fatalf("expected diagnostics, got none; stderr=%q", res.Stderr)
	}
	d := res.Diagnostics[0]
	if d.FilePath != "broken.go" || d.Line != 3 {
		t.Errorf("diagnostic location = %s:%d, want broken.go:3 (%+v)", d.FilePath, d.Line, d)
	}
	if d.Kind != DiagTypeMismatch {
		t.Errorf("diagnostic kind = %s, want %s (%q)", d.Kind, DiagTypeMismatch, d.Message)
	}
}

func TestRunGo_FailingTest(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{
		"x.go":      "package sandbox\n\nfunc X() int { return 1 }\n",
		"x_test.go": "package sandbox\n\nimport \"testing\"\n\nfunc TestX(t *testing.T) {\n\tif X() != 2 {\n\t\tt.Fatal(\"expected 2\")\n\t}\n}\n\nfunc TestOK(t *testing.T) {}\n",
	})
	if err != nil {
		t.Fatalf("RunGo error: %v", err)
	}
	if res.Success {
		t.Fatalf("expected failure, got %+v", res)
	}
	if res.TestsFailed != 1 || res.TestsPassed != 1 || res.TestsTotal != 2 {
		t.Errorf("counts = passed %d failed %d total %d, want 1/1/2", res.TestsPassed, res.TestsFailed, res.TestsTotal)
	}
	if len(res.FailedTestNames) != 1 || res.FailedTestNames[0] != "TestX" {
		t.Errorf("failed names = %v, want [TestX]", res.FailedTestNames)
	}
	if len(res.Diagnostics) != 1 || res.Diagnostics[0].Kind != DiagTestFailure {
		t.Errorf("diagnostics = %+v, want one DiagTestFailure", res.Diagnostics)
	}
}

func TestRunGo_BraceInStringLiteral(t *testing.T) {
	res, err := RunGo(context.Background(), map[string]string{
		"s.go":      "package sandbox\n\nfunc S() string { return \"}\" }\n",
		"s_test.go": "package sandbox\n\nimport \"testing\"\n\nfunc TestS(t *testing.T) {\n\tif S() != \"}\" {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n",
	})
	if err != nil {
		t.Fatalf("RunGo error: %v", err)
	}
	if !res.Success {
		t.Fatalf("a brace inside a string literal must compile; got %+v", res)
	}
}

func TestRunGo_Timeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	res, err := RunGo(ctx, map[string]string{
		"h.go":      "package sandbox\n\nfunc Hang() { select {} }\n",
		"h_test.go": "package sandbox\n\nimport \"testing\"\n\nfunc TestHang(t *testing.T) { Hang() }\n",
	})
	if err != nil {
		t.Fatalf("RunGo error: %v", err)
	}
	if !res.TimedOut || res.Success {
		t.Fatalf("expected TimedOut=true Success=false, got %+v", res)
	}
}

func TestRunGo_RejectsPathEscape(t *testing.T) {
	_, err := RunGo(context.Background(), map[string]string{"../evil.go": "package x\n"})
	if err == nil {
		t.Fatal("expected error for path escaping the sandbox")
	}
}
