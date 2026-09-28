package swyplang

import (
	"bytes"
	"strings"
	"testing"
)

func TestIntentLexing(t *testing.T) {
	source := "// #natural: \"ignored\";\nfn main(){print(\"#natural: ignored\");\n#limbaj_natural: \"Afiseaza salut\";\n}"
	intents, err := Intents("test.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	if len(intents) != 1 || intents[0].Line != 3 {
		t.Fatalf("%+v", intents)
	}
	expanded, err := Expand("test.swyp", source, []Replacement{{0, `print("salut");`}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(expanded, `print("#natural: ignored");`) {
		t.Fatal("changed handwritten source")
	}
	p, err := Parse("expanded", expanded)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err = p.Run(&out, 1000); err != nil {
		t.Fatal(err)
	}
	if out.String() != "#natural: ignored\nsalut\n" {
		t.Fatal(out.String())
	}
}
func TestIntentRejections(t *testing.T) {
	source := `fn main(){#natural: "Print a number";}`
	for _, replacements := range [][]Replacement{
		nil, {{1, `print(1);`}}, {{0, `print(unknown);`}}, {{0, `}`}}, {{0, `print(1);`}, {0, `print(2);`}}, {{0, `let x=1; x="bad";`}}, {{0, `}` + "\nfn surprise(){print(1);"}},
	} {
		if _, err := Expand("test", source, replacements); err == nil {
			t.Fatalf("accepted invalid replacement %+v", replacements)
		}
	}
	for _, source := range []string{`fn main(){#natural "x";}`, `fn main(){#natural: "x"}`, `fn main(){#other: "x";}`, `fn main(){#natural: "";}`, `fn main(){#natural: "unterminated;}`} {
		if _, err := Intents("bad", source); err == nil {
			t.Fatalf("accepted %s", source)
		}
	}
}
func TestIntentIntroducesVariable(t *testing.T) {
	source := `fn main(){let limit=10; #natural: "Sum squares into total";print(total);}`
	expanded, err := Expand("test", source, []Replacement{{0, `let total=0;let i=1;while i<=limit{total=total+i*i;i=i+1;}`}})
	if err != nil {
		t.Fatal(err)
	}
	p, _ := Parse("expanded", expanded)
	var out bytes.Buffer
	if err = p.Run(&out, 10000); err != nil {
		t.Fatal(err)
	}
	if out.String() != "385\n" {
		t.Fatal(out.String())
	}
}
