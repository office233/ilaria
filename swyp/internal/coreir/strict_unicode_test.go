package coreir

import (
	"strings"
	"testing"
)

func TestDecodeStrictRejectsUnicodeCaseAliases(t *testing.T) {
	var payload struct {
		Slots []int `json:"slots"`
	}
	for _, source := range []string{
		`{"slots":[1],"\u017Flots":[2]}`,
		`{"\u017Flots":[1],"SLOTS":[2]}`,
	} {
		if err := DecodeStrict([]byte(source), &payload); err == nil || !strings.Contains(err.Error(), "duplicate object key") {
			t.Fatalf("Unicode alias bypassed strict duplicate check: source=%s payload=%+v err=%v", source, payload, err)
		}
	}
}
