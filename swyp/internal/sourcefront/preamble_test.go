package sourcefront

import (
	"strings"
	"testing"
)

func TestParsePreamblePreservesBodyLocations(t *testing.T) {
	source := "// header\nmodule platform.math;\nuse platform.types;\nuse platform.contracts;\nfn main() {}\n"
	p, body, err := ParsePreamble("module.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if p.Module != "platform.math" || strings.Join(p.Uses, ",") != "platform.types,platform.contracts" {
		t.Fatalf("preamble=%+v", p)
	}
	if len(body) != len(source) {
		t.Fatalf("body length=%d source length=%d", len(body), len(source))
	}
	if strings.Count(body, "\n") != strings.Count(source, "\n") {
		t.Fatal("blanking changed line structure")
	}
	if !strings.Contains(body, "fn main() {}") || strings.Contains(body, "module platform.math") {
		t.Fatalf("unexpected blanked body %q", body)
	}
}

func TestParsePreambleRejectsAmbiguousOrDuplicateDeclarations(t *testing.T) {
	cases := []string{
		"module a; module b; fn main() {}",
		"use a; module b; fn main() {}",
		"use a.b; use a.b; fn main() {}",
		"module a.; fn main() {}",
		"use a fn main() {}",
	}
	for _, source := range cases {
		if _, _, err := ParsePreamble("bad.swyp", source); err == nil {
			t.Fatalf("accepted invalid preamble %q", source)
		}
	}
}

func TestParsePreambleLeavesLegacySourceUntouched(t *testing.T) {
	source := "fn main() { print(1); }"
	p, body, err := ParsePreamble("legacy.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if p.Module != "" || len(p.Uses) != 0 || body != source {
		t.Fatalf("preamble=%+v body=%q", p, body)
	}
}
