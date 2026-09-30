package protocol

import "testing"

func TestPrivacyTransferFailsClosed(t *testing.T) {
	tests := []struct {
		raw  string
		want bool
	}{
		{string(PrivacyPublic), true},
		{string(PrivacyCurated), true},
		{string(PrivacyDeviceNonPersonal), true},
		{string(PrivacyLocalPrivate), false},
		{string(PrivacySensitive), false},
		{string(PrivacyForbiddenGlobal), false},
	}
	for _, tc := range tests {
		got, err := IsGloballyTransferable(tc.raw)
		if err != nil {
			t.Fatalf("%s: %v", tc.raw, err)
		}
		if got != tc.want {
			t.Fatalf("%s: transferable=%v, want %v", tc.raw, got, tc.want)
		}
	}
	if _, err := IsGloballyTransferable("UNKNOWN"); err == nil {
		t.Fatal("unknown privacy class must fail closed")
	}
}

func TestValidateSHA256(t *testing.T) {
	good := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := ValidateSHA256("hash", good, false); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "ABCDEF", good[:63], good[:63] + "z"} {
		if err := ValidateSHA256("hash", bad, false); err == nil {
			t.Fatalf("accepted invalid digest %q", bad)
		}
	}
}
