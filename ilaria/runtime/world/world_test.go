package world

import (
	"testing"

	"ilaria/generated/myriad"
	"ilaria/runtime/protocol"
)

func validEvent() myriad.WorldEvent {
	return myriad.WorldEvent{
		ProtocolVersion: protocol.Version,
		EventID:         "evt-1",
		DeviceClass:     "vehicle",
		SourceNamespace: "obd2",
		ObservationType: "diagnostic",
		Features: map[string]string{
			"rpm": "820",
			"dtc": "P0301",
		},
		Result:        "verified cylinder-1 misfire",
		Verifier:      "obd-replay-v1",
		ConfidencePPM: 990_000,
		PrivacyClass:  string(protocol.PrivacyDeviceNonPersonal),
	}
}

func TestWorldEventHashIsStableAcrossMapInsertionOrder(t *testing.T) {
	a := validEvent()
	b := validEvent()
	b.Features = map[string]string{}
	b.Features["dtc"] = "P0301"
	b.Features["rpm"] = "820"

	ha, err := Hash(a)
	if err != nil {
		t.Fatal(err)
	}
	hb, err := Hash(b)
	if err != nil {
		t.Fatal(err)
	}
	if ha != hb {
		t.Fatalf("hash differs: %s != %s", ha, hb)
	}
}

func TestWorldEventPrivacy(t *testing.T) {
	e := validEvent()
	ok, err := IsGloballyTransferable(e)
	if err != nil || !ok {
		t.Fatalf("transferable event: ok=%v err=%v", ok, err)
	}
	e.PrivacyClass = string(protocol.PrivacyLocalPrivate)
	ok, err = IsGloballyTransferable(e)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("local private event must not be globally transferable")
	}
}

func TestWorldEventRejectsVerifierWithoutResult(t *testing.T) {
	e := validEvent()
	e.Result = ""
	if err := Validate(e); err == nil {
		t.Fatal("expected verifier/result validation error")
	}
}
