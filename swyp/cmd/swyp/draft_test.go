package main

import (
	"context"
	"errors"
	"strings"
	"swyp-lang/internal/ilaria"
	"testing"
)

type draftBackend struct {
	reply string
	err   error
}

func (b draftBackend) Chat(context.Context, string, []ilaria.Message) (string, error) {
	return b.reply, b.err
}
func TestDraftValidation(t *testing.T) {
	for _, tc := range []struct {
		reply string
		err   error
		ok    bool
	}{
		{`fn main(){print(42);}`, nil, true},
		{`fn main(){print(missing);}`, nil, false},
		{`fn main(){let x=1;x="bad";}`, nil, false},
		{"UNSUPPORTED: HTTP and email", nil, false},
		{"```swyp\nfn main(){}\n```", nil, false},
		{"", errors.New("offline"), false},
	} {
		source, err := verifiedDraft(context.Background(), draftBackend{tc.reply, tc.err}, "test")
		if (err == nil) != tc.ok {
			t.Fatalf("%q: %v", tc.reply, err)
		}
		if tc.ok && !strings.Contains(source, "behavior has not been verified") {
			t.Fatal("missing provenance")
		}
	}
}
