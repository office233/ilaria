package l402

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sync"
	"time"
)

// Invoice represents a Lightning Network micro-payment invoice.
type Invoice struct {
	ID          string    `json:"id"`
	PaymentHash string    `json:"payment_hash"`
	AmountSats  int64     `json:"amount_sats"` // e.g. 10 sats (~$0.007)
	Description string    `json:"description"`
	Settled     bool      `json:"settled"`
	Preimage    string    `json:"preimage,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// Macaroon represents a decentralized bearer token with cryptographic caveats.
type Macaroon struct {
	Location   string   `json:"location"`
	Identifier string   `json:"identifier"`
	Caveats    []string `json:"caveats"`
	Signature  string   `json:"signature"`
}

// L402Challenge represents the HTTP 402 Payment Required header payload.
type L402Challenge struct {
	Token   *Macaroon `json:"token"`
	Invoice *Invoice  `json:"invoice"`
}

// SettlementEngine coordinates machine-to-machine financial micro-payments.
type SettlementEngine struct {
	mu           sync.RWMutex
	rootKey      []byte
	invoices     map[string]*Invoice
	settledCount int64
	totalSats    int64
}

// NewSettlementEngine initializes the L402 cryptographic micro-settlement engine.
func NewSettlementEngine(rootKey []byte) *SettlementEngine {
	if len(rootKey) == 0 {
		rootKey = make([]byte, 32)
		if _, err := rand.Read(rootKey); err != nil {
			return nil
		}
	}

	return &SettlementEngine{
		rootKey:  append([]byte(nil), rootKey...),
		invoices: make(map[string]*Invoice),
	}
}

// GenerateChallenge creates an HTTP 402 challenge with an invoice and Macaroon.
func (se *SettlementEngine) GenerateChallenge(amountSats int64, description string) (*L402Challenge, string, error) {
	se.mu.Lock()
	defer se.mu.Unlock()

	if amountSats <= 0 {
		return nil, "", fmt.Errorf("invoice amount must be positive")
	}
	// 1. Generate 32-byte cryptographic preimage
	preimageBytes := make([]byte, 32)
	if _, err := rand.Read(preimageBytes); err != nil {
		return nil, "", err
	}
	preimageHex := hex.EncodeToString(preimageBytes)

	// 2. Compute PaymentHash = SHA256(preimage)
	h := sha256.Sum256(preimageBytes)
	paymentHash := hex.EncodeToString(h[:])

	invID := fmt.Sprintf("inv_%s", paymentHash[:12])
	inv := &Invoice{
		ID:          invID,
		PaymentHash: paymentHash,
		AmountSats:  amountSats,
		Description: description,
		Settled:     false,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(10 * time.Minute),
	}

	se.invoices[paymentHash] = inv
	if len(se.invoices) > 200 {
		now := time.Now()
		// First pass: evict expired or already settled invoices (except current)
		for k, v := range se.invoices {
			if k != paymentHash && (v.Settled || now.After(v.ExpiresAt)) {
				delete(se.invoices, k)
				if len(se.invoices) <= 200 {
					break
				}
			}
		}
		// Second pass if still above threshold: evict oldest
		if len(se.invoices) > 200 {
			for k := range se.invoices {
				if k != paymentHash {
					delete(se.invoices, k)
					if len(se.invoices) <= 200 {
						break
					}
				}
			}
		}
	}
	// 3. Mint Macaroon
	mac := hmac.New(sha256.New, se.rootKey)
	caveat := fmt.Sprintf("payment_hash=%s", paymentHash)
	mac.Write([]byte(fmt.Sprintf("%s:%s", invID, caveat)))
	sig := hex.EncodeToString(mac.Sum(nil))

	macaroon := &Macaroon{
		Location:   "swypik-mesh-node",
		Identifier: invID,
		Caveats:    []string{caveat},
		Signature:  sig,
	}

	challenge := &L402Challenge{
		Token:   macaroon,
		Invoice: func() *Invoice { copy := *inv; return &copy }(),
	}

	return challenge, preimageHex, nil
}

// SettleInvoice simulates settlement of the invoice by providing the secret preimage.
func (se *SettlementEngine) SettleInvoice(paymentHash string, preimage string) error {
	se.mu.Lock()
	defer se.mu.Unlock()

	inv, ok := se.invoices[paymentHash]
	if !ok {
		return fmt.Errorf("invoice with payment hash '%s' not found", paymentHash)
	}

	// Verify SHA256(preimage) == paymentHash
	preimageBytes, err := hex.DecodeString(preimage)
	if err != nil {
		return fmt.Errorf("invalid preimage encoding: %w", err)
	}
	h := sha256.Sum256(preimageBytes)
	if hex.EncodeToString(h[:]) != paymentHash {
		return fmt.Errorf("cryptographic preimage does not match invoice payment hash")
	}

	if inv.Settled {
		return nil
	}
	if time.Now().After(inv.ExpiresAt) {
		return fmt.Errorf("invoice expired")
	}
	inv.Settled = true
	inv.Preimage = preimage
	se.settledCount++
	se.totalSats += inv.AmountSats

	return nil
}

// VerifyL402Auth verifies that the Macaroon and Preimage constitute valid authorization.
func (se *SettlementEngine) VerifyL402Auth(token *Macaroon, preimage string) (bool, error) {
	se.mu.RLock()
	defer se.mu.RUnlock()

	if token == nil || preimage == "" {
		return false, fmt.Errorf("missing macaroon or preimage")
	}

	// Extract payment hash from preimage
	preimageBytes, err := hex.DecodeString(preimage)
	if err != nil {
		return false, fmt.Errorf("invalid preimage hex: %w", err)
	}
	h := sha256.Sum256(preimageBytes)
	computedHash := hex.EncodeToString(h[:])

	// Check invoice state
	inv, ok := se.invoices[computedHash]
	if !ok || !inv.Settled {
		return false, fmt.Errorf("invoice for payment hash %s is unconfirmed or unsettled", computedHash)
	}

	if time.Now().After(inv.ExpiresAt) || token.Identifier != inv.ID || len(token.Caveats) != 1 || token.Caveats[0] != "payment_hash="+computedHash {
		return false, fmt.Errorf("expired invoice or invalid token caveats")
	}
	// Verify Macaroon HMAC signature
	mac := hmac.New(sha256.New, se.rootKey)
	caveat := fmt.Sprintf("payment_hash=%s", computedHash)
	mac.Write([]byte(fmt.Sprintf("%s:%s", token.Identifier, caveat)))
	expectedSig := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(token.Signature), []byte(expectedSig)) {
		return false, fmt.Errorf("macaroon cryptographic signature invalid")
	}

	return true, nil
}

// PurchaseOrder models an autonomous component procurement order.
type PurchaseOrder struct {
	PartNumber   string    `json:"part_number"`
	Description  string    `json:"description"`
	EstimatedRUL float64   `json:"estimated_rul_hours"`
	MaxCostSats  int64     `json:"max_cost_sats"`
	DeliveryLat  float64   `json:"delivery_lat"`
	DeliveryLon  float64   `json:"delivery_lon"`
	SignedBy     string    `json:"signed_by"`
	Status       string    `json:"status"`
	Timestamp    time.Time `json:"timestamp"`
}

// EvaluateMaintenanceAndProcure checks Remaining Useful Life and signs an automated purchase order.
func (se *SettlementEngine) EvaluateMaintenanceAndProcure(
	vibrationG float64,
	thermalHours float64,
	machineID string,
) (*PurchaseOrder, bool) {
	// Simple RUL estimator: higher vibration and thermal hours shorten bearing life
	baseLifeHours := 5000.0
	wearRate := (vibrationG * 2.5) + (thermalHours * 0.05)
	estimatedRUL := baseLifeHours / math.Max(1.0, wearRate)

	// Threshold: if RUL < 150 hours, trigger autonomous procurement
	if estimatedRUL < 150.0 {
		po := &PurchaseOrder{
			PartNumber:   "BRG-6205-2RSH",
			Description:  "Precision Deep Groove Hybrid Ceramic Ball Bearing",
			EstimatedRUL: math.Round(estimatedRUL*10) / 10,
			MaxCostSats:  15000, // ~15,000 sats (~$10.50)
			DeliveryLat:  44.4268,
			DeliveryLon:  26.1025,
			SignedBy:     fmt.Sprintf("TPM2_KEY_%s", machineID),
			Status:       "DISPATCHED_TO_DELIVERY_DRONE",
			Timestamp:    time.Now(),
		}
		return po, true
	}

	return nil, false
}

// GetMetrics returns financial settlement telemetry.
func (se *SettlementEngine) GetMetrics() (settledCount int64, totalSats int64) {
	se.mu.RLock()
	defer se.mu.RUnlock()
	return se.settledCount, se.totalSats
}
