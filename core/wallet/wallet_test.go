package wallet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCryptographicWallet(t *testing.T) {
	w, err := NewWallet()
	if err != nil {
		t.Fatalf("failed to initialize wallet: %v", err)
	}

	addr := w.GetAddress()
	if !strings.HasPrefix(addr, "swp_") || len(addr) < 10 {
		t.Errorf("invalid address format: %s", addr)
	}

	initialBal := w.GetBalance()
	w.CreditReward(50.00)
	if w.GetBalance() != initialBal+50.00 {
		t.Errorf("expected balance %.2f, got %.2f", initialBal+50.00, w.GetBalance())
	}

	// Test real Ed25519 signing
	recipient := "swp_0123456789abcdef0123456789abcdef01234567"
	tx, err := w.SignTransfer(recipient, 25.0)
	if err != nil {
		t.Fatalf("failed to sign transfer: %v", err)
	}

	if tx.Signature == "" || len(tx.Signature) != 128 { // 64 bytes hex encoded = 128 hex chars
		t.Errorf("invalid Ed25519 signature: %s", tx.Signature)
	}
}

func TestWalletPersistence(t *testing.T) {
	tempPath := filepath.Join(os.TempDir(), "test_swypik_wallet.json")
	defer os.Remove(tempPath)

	w1, err := GetOrCreateWallet(tempPath)
	if err != nil {
		t.Fatalf("failed to create wallet: %v", err)
	}

	w1.CreditReward(123.45)
	if err := w1.SaveToFile(tempPath); err != nil {
		t.Fatalf("failed to save wallet: %v", err)
	}

	// Reload from disk
	w2, err := LoadWalletFromFile(tempPath)
	if err != nil {
		t.Fatalf("failed to load wallet: %v", err)
	}

	if w2.GetAddress() != w1.GetAddress() {
		t.Errorf("address mismatch after reload: %s != %s", w2.GetAddress(), w1.GetAddress())
	}
	if w2.GetBalance() != 123.45 {
		t.Errorf("balance mismatch after reload: %.2f != 123.45", w2.GetBalance())
	}
}
