package swyplang

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestJavaScriptParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	for _, source := range []string{sumSource, fibSource, clampSource,
		`fn main(){let x=1;if true{let x=x+1;print(x);}print(x);}`,
		`fn ping(x:number)->number{print(x);return x;}fn main(){print(ping(1)+ping(2));}`,
		`fn boom()->bool{print(99);return true;}fn main(){print(false&&boom(),true||boom());}`,
		`fn main(){print("hello"+" world","x"=="x",1==true,arg(0),clock()>=0);}`,
	} {
		p, err := Parse("web.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		js, err := p.EmitJS()
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "test.js")
		if err = os.WriteFile(path, []byte(js+"\nswypRun([12],console.log);"), 0600); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(node, path).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		var want bytes.Buffer
		if err = p.RunArgs(&want, 1_000_000, []float64{12}); err != nil {
			t.Fatal(err)
		}
		if !equivalentOutput(string(out), want.String()) {
			t.Fatalf("JS %q != interpreter %q", out, want.String())
		}
	}
}
func TestJavaScriptFailure(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	p, err := Parse("bad.swyp", `fn main(){print(1/0);}`)
	if err != nil {
		t.Fatal(err)
	}
	js, err := p.EmitJS()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "test.js")
	if err = os.WriteFile(path, []byte(js+"\nswypRun([],console.log);"), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, path).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "division by zero") {
		t.Fatalf("%s %v", out, err)
	}
}
func TestHTMLSourceEscaping(t *testing.T) {
	p, err := Parse("escape.swyp", `fn main(){print("</script><script>alert(1)</script>");}`)
	if err != nil {
		t.Fatal(err)
	}
	html, err := p.EmitHTML()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(html, "</script>") != 1 {
		t.Fatal("source broke script boundary")
	}
	if !strings.Contains(html, "textContent") || !strings.Contains(html, "new Worker") {
		t.Fatal("missing worker runner")
	}
}
