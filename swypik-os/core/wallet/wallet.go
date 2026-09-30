package wallet

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"swypik-os/internal/storage"
	"sync"
	"time"

	resourcepolicy "swypik-os/core/resource"
)

// Transaction represents a cryptographically signed value transfer.
type Transaction struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Amount    float64   `json:"amount"`
	Timestamp time.Time `json:"timestamp"`
	Signature string    `json:"signature"`
}

// Wallet manages cryptographic keys and balances for the sovereign user.
type Wallet struct {
	mu           sync.RWMutex
	PublicKey    ed25519.PublicKey
	PrivateKey   ed25519.PrivateKey
	Address      string
	Balance      float64
	Transactions []Transaction
}

func (w *Wallet) appendTransaction(tx Transaction) {
	limit := resourcepolicy.Default().MaxWalletTransactions
	if limit < 1 {
		limit = 1
	}
	if len(w.Transactions) < limit {
		w.Transactions = append(w.Transactions, tx)
		return
	}
	copy(w.Transactions, w.Transactions[1:])
	w.Transactions[limit-1] = tx
}

type walletPersistedData struct {
	PublicKeyHex  string        `json:"public_key_hex"`
	PrivateKeyHex string        `json:"private_key_hex"`
	Address       string        `json:"address"`
	Balance       float64       `json:"balance"`
	Transactions  []Transaction `json:"transactions"`
}

// NewWallet creates an in-memory Ed25519 sovereign cryptographic wallet.
func NewWallet() (*Wallet, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate cryptographic keypair: %w", err)
	}

	// Address is the hex encoded SHA-256 hash of the public key
	h := sha256.Sum256(pub)
	address := "swp_" + hex.EncodeToString(h[:20])

	return &Wallet{
		PublicKey:    pub,
		PrivateKey:   priv,
		Address:      address,
		Balance:      0.0,
		Transactions: make([]Transaction, 0),
	}, nil
}

// SaveToFile persists plaintext keys and balance with restrictive file permissions.
func (w *Wallet) SaveToFile(filePath string) error {
	w.mu.RLock()
	defer w.mu.RUnlock()

	data := walletPersistedData{
		PublicKeyHex:  hex.EncodeToString(w.PublicKey),
		PrivateKeyHex: hex.EncodeToString(w.PrivateKey),
		Address:       w.Address,
		Balance:       w.Balance,
		Transactions:  w.Transactions,
	}

	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode wallet data: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
		return err
	}
	return storage.WriteFile(filePath, raw, 0600)
}

// LoadWalletFromFile recovers an existing wallet from disk storage.
func LoadWalletFromFile(filePath string) (*Wallet, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var data walletPersistedData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("failed to decode wallet file: %w", err)
	}

	pub, err := hex.DecodeString(data.PublicKeyHex)
	if err != nil {
		return nil, fmt.Errorf("invalid public key hex: %w", err)
	}
	priv, err := hex.DecodeString(data.PrivateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("invalid private key hex: %w", err)
	}

	if len(pub) != ed25519.PublicKeySize || len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid wallet key length")
	}
	derived := ed25519.NewKeyFromSeed(priv[:ed25519.SeedSize])
	h := sha256.Sum256(pub)
	if !bytes.Equal(derived, priv) || !bytes.Equal(derived[32:], pub) || data.Address != "swp_"+hex.EncodeToString(h[:20]) {
		return nil, fmt.Errorf("wallet keys or address do not match")
	}
	if data.Balance < 0 || math.IsNaN(data.Balance) || math.IsInf(data.Balance, 0) {
		return nil, fmt.Errorf("invalid wallet balance")
	}

	return &Wallet{
		PublicKey:    ed25519.PublicKey(pub),
		PrivateKey:   ed25519.PrivateKey(priv),
		Address:      data.Address,
		Balance:      data.Balance,
		Transactions: data.Transactions,
	}, nil
}

// GetOrCreateWallet loads the persistent wallet if it exists, or creates and saves a new one.
func GetOrCreateWallet(filePath string) (*Wallet, error) {
	if _, err := os.Stat(filePath); err == nil {
		return LoadWalletFromFile(filePath)
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	w, err := NewWallet()
	if err != nil {
		return nil, err
	}

	if err := w.SaveToFile(filePath); err != nil {
		return nil, err
	}
	return w, nil
}

// GetAddress returns the sovereign wallet public address.
func (w *Wallet) GetAddress() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.Address
}

// GetBalance returns the current balance in SWP.
func (w *Wallet) GetBalance() float64 {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.Balance
}

// CreditReward adds verified proof-of-work rewards from swarm compute.
func (w *Wallet) CreditReward(amount float64) {
	if amount <= 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if math.IsInf(w.Balance+amount, 0) {
		return
	}
	w.Balance += amount
	w.appendTransaction(Transaction{
		ID:        fmt.Sprintf("tx_reward_%d", time.Now().UnixNano()),
		From:      "swp_swarm_network_genesis",
		To:        w.Address,
		Amount:    amount,
		Timestamp: time.Now(),
		Signature: "PROOF_OF_WORK_VERIFIED",
	})
}

// SignTransfer creates and signs a real transfer transaction with Ed25519.
func (w *Wallet) SignTransfer(to string, amount float64) (*Transaction, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if amount <= 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return nil, fmt.Errorf("invalid transfer amount: %.2f", amount)
	}
	if w.Balance < amount {
		return nil, fmt.Errorf("insufficient balance: have %.2f, need %.2f", w.Balance, amount)
	}

	if to == "" || len(w.PrivateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid recipient or signing key")
	}
	w.Balance -= amount
	now := time.Now()
	txID := fmt.Sprintf("tx_%d", now.UnixNano())
	payload := fmt.Sprintf("%s:%s:%s:%.6f:%d", txID, w.Address, to, amount, now.Unix())

	sig := ed25519.Sign(w.PrivateKey, []byte(payload))
	sigHex := hex.EncodeToString(sig)

	tx := Transaction{
		ID:        txID,
		From:      w.Address,
		To:        to,
		Amount:    amount,
		Timestamp: now,
		Signature: sigHex,
	}

	w.appendTransaction(tx)
	return &tx, nil
}

// VerifySignature validates any transaction against the sender's public key.
func VerifySignature(pubKey ed25519.PublicKey, payload []byte, sigHex string) bool {
	if len(pubKey) != ed25519.PublicKeySize {
		return false
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	return ed25519.Verify(pubKey, payload, sig)
}
