package security

import (
	"bytes"
	"testing"
)

func TestSecurityGuard(t *testing.T) {
	guard := NewSecurityGuard()
	// Normal unit test run is not attached to a debugger
	attached := guard.IsDebuggerAttached()
	t.Logf("Debugger attached: %v", attached)

	// Test AES-256-GCM memory encryption and decryption
	secretKey := []byte("SwypikOS-Sovereign-Secret-Key-2026")
	secretCode := []byte("func SecretCognitiveCore() { return true }")

	encryptedHex, err := EncryptSecretPayload(secretCode, secretKey)
	if err != nil {
		t.Fatalf("failed to encrypt payload: %v", err)
	}

	decryptedBytes, err := DecryptSecretPayload(encryptedHex, secretKey)
	if err != nil {
		t.Fatalf("failed to decrypt payload: %v", err)
	}

	if !bytes.Equal(decryptedBytes, secretCode) {
		t.Errorf("decrypted mismatch: got %s, want %s", string(decryptedBytes), string(secretCode))
	}
}
