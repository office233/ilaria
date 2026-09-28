package wallet

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestCorruptWalletNeverOverwritten(t *testing.T) {
	p := filepath.Join(t.TempDir(), "wallet.json")
	original := []byte(`{"private_key_hex":"00"}`)
	if err := os.WriteFile(p, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := GetOrCreateWallet(p); err == nil {
		t.Fatal("corrupt wallet accepted")
	}
	got, err := os.ReadFile(p)
	if err != nil || string(got) != string(original) {
		t.Fatal("wallet overwritten")
	}
}

func TestRejectNonFiniteAmounts(t *testing.T) {
	w, err := NewWallet()
	if err != nil {
		t.Fatal(err)
	}
	w.CreditReward(10)
	for _, amount := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1, 0} {
		w.CreditReward(amount)
		if _, err := w.SignTransfer("recipient", amount); err == nil {
			t.Errorf("accepted %v", amount)
		}
	}
	if w.GetBalance() != 10 {
		t.Fatal("invalid amount changed balance")
	}
	if VerifySignature(nil, []byte("payload"), "00") {
		t.Fatal("invalid public key accepted")
	}
}
