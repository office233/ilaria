package componentspec

import "testing"

func TestComponentManifestHIRDeclarations(t *testing.T) {
	m, err := Parse("protocol.swyp", `module platform.protocols;
record Request {
    field id: string;
    field count: u64;
}`)
	if err != nil {
		t.Fatal(err)
	}
	h, err := m.HIRDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	if h.Name != "platform.protocols" || len(h.Declarations) != 1 {
		t.Fatalf("HIR=%+v", h)
	}
	d := h.Declarations[0]
	if d.ID.Canonical() != "platform.protocols::record::Request" || len(d.Fields) != 2 || d.Fields[1].Type.Name != "u64" {
		t.Fatalf("record HIR=%+v", d)
	}
}
