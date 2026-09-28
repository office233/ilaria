package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"sync"
)

// SecurityGuard handles anti-debugging, anti-tampering, and memory protection.
type SecurityGuard struct {
	mu           sync.RWMutex
	debugAlerted bool
}

func NewSecurityGuard() *SecurityGuard {
	return &SecurityGuard{}
}

// IsDebuggerAttached detects whether an active debugger is inspecting this binary.
func (g *SecurityGuard) IsDebuggerAttached() bool {
	return checkDebuggerAttached()
}

// EncryptSecretPayload encrypts sensitive algorithmic strings/weights in memory using AES-256-GCM.
func EncryptSecretPayload(plaintext []byte, key []byte) (string, error) {
	hasher := sha256.Sum256(key)
	block, err := aes.NewCipher(hasher[:])
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return hex.EncodeToString(ciphertext), nil
}

// DecryptSecretPayload decrypts sensitive assets directly into ephemeral RAM.
func DecryptSecretPayload(hexCiphertext string, key []byte) ([]byte, error) {
	data, err := hex.DecodeString(hexCiphertext)
	if err != nil {
		return nil, err
	}

	hasher := sha256.Sum256(key)
	block, err := aes.NewCipher(hasher[:])
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}
