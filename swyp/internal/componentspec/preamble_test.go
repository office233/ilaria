package componentspec

import (
	"strings"
	"testing"
)

func TestComponentParserSharesModulePreamble(t *testing.T) {
	source := `module platform.control;
use platform.protocols;
use platform.security;
record Request {
    field id: string;
}`
	m, err := Parse("control.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if m.Module != "platform.control" || strings.Join(m.Uses, ",") != "platform.protocols,platform.security" {
		t.Fatalf("manifest preamble module=%q uses=%v", m.Module, m.Uses)
	}
	data, err := m.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"module": "platform.control"`) || !strings.Contains(string(data), `"uses"`) {
		t.Fatalf("canonical manifest lost preamble: %s", data)
	}
}
