package hir

import "testing"

func TestParseTypeRefRoundTripRicherTypes(t *testing.T) {
	cases := []string{
		"i64",
		"array<u64,4>",
		"slice<bytes>",
		"vec<option<i64>>",
		"result<option<i64>,array<u64,16>>",
		"opaque<platform.handles.Socket>",
		"tuple<i64,bool,bytes>",
	}
	for _, source := range cases {
		t.Run(source, func(t *testing.T) {
			got, err := ParseTypeRef(source)
			if err != nil {
				t.Fatal(err)
			}
			if got.String() != source {
				t.Fatalf("round trip=%q want=%q type=%+v", got.String(), source, got)
			}
		})
	}
}

func TestParseTypeRefRejectsInvalidGenericContracts(t *testing.T) {
	cases := []string{
		"array<i64>",
		"array<i64,nope>",
		"slice<i64,u64>",
		"option<>",
		"result<i64>",
		"opaque<i64,u64>",
		"i64<u64>",
		"array<void,1>",
		"result<i64,void>",
	}
	for _, source := range cases {
		if _, err := ParseTypeRef(source); err == nil {
			t.Fatalf("accepted invalid type %q", source)
		}
	}
}
