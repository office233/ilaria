package checkout

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func TestCheckoutPersistsStripeReadyOrderSessionAndPayment(t *testing.T) {
	store := &recordingStore{}
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	service := NewService(store, func() time.Time { return now })

	result, err := service.Checkout(context.Background(), CheckoutInput{
		UserID:   "11111111-1111-4111-8111-111111111111",
		Currency: "ron",
		Items: []AddCartItemInput{
			{ProductID: "prod_local_1", SKUID: "sku_1", Quantity: 2, UnitAmountRON: 1200},
			{ProductID: "prod_local_2", Quantity: 1, UnitAmountRON: 600},
		},
		Customer: Customer{Email: "buyer@example.com"},
		Metadata: map[string]any{
			"source_share_id": "share_1",
		},
	})
	if err != nil {
		t.Fatalf("expected checkout, got %v", err)
	}

	if result.CheckoutID == "" {
		t.Fatal("expected checkout id")
	}
	if result.Status != "requires_payment" {
		t.Fatalf("expected API status to remain requires_payment, got %q", result.Status)
	}
	if result.TotalAmountRON != 3000 {
		t.Fatalf("expected total amount 3000, got %d", result.TotalAmountRON)
	}
	if len(store.checkoutRecords) != 1 {
		t.Fatalf("expected one checkout record, got %d", len(store.checkoutRecords))
	}

	record := store.checkoutRecords[0]
	if record.Provider != "stripe" {
		t.Fatalf("expected stripe provider, got %q", record.Provider)
	}
	if record.ProviderSessionID != result.CheckoutID {
		t.Fatalf("expected provider session id to match result id, got %q", record.ProviderSessionID)
	}
	if record.UserID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("expected user id on checkout record, got %q", record.UserID)
	}
	if record.CartID == "" {
		t.Fatal("expected a shared cart id for inline checkout items")
	}
	if len(record.Items) != 2 {
		t.Fatalf("expected two checkout items, got %d", len(record.Items))
	}
	for _, item := range record.Items {
		if item.CartID != record.CartID {
			t.Fatalf("expected inline item cart id %q, got %q", record.CartID, item.CartID)
		}
	}
	if record.Metadata["merchant_of_record"] != "platform" {
		t.Fatalf("expected platform merchant-of-record metadata, got %#v", record.Metadata["merchant_of_record"])
	}
	if record.Metadata["connect_charge_type"] != "destination_charge_ready" {
		t.Fatalf("expected Connect-ready charge metadata, got %#v", record.Metadata["connect_charge_type"])
	}
	if record.Payment.ProviderPaymentID == "" {
		t.Fatal("expected pending provider payment id")
	}
	if record.Payment.Status != "pending" {
		t.Fatalf("expected pending payment record, got %q", record.Payment.Status)
	}
}

func TestRecordStripeWebhookRequiresValidSignature(t *testing.T) {
	service := NewService(nil, time.Now)
	payload := []byte(`{"id":"evt_123","type":"checkout.session.completed"}`)
	secret := "whsec_test_secret"
	signature := stripeSignature(payload, secret, time.Now())

	result, err := service.RecordStripeWebhook(context.Background(), payload, signature, secret)
	if err != nil {
		t.Fatalf("expected valid signed webhook, got %v", err)
	}
	if !result.Received || result.EventID != "evt_123" || result.EventType != "checkout.session.completed" {
		t.Fatalf("unexpected result: %#v", result)
	}

	if _, err := service.RecordStripeWebhook(context.Background(), payload, "", secret); err == nil {
		t.Fatal("expected missing signature to fail")
	}
	if _, err := service.RecordStripeWebhook(context.Background(), payload, signature, "wrong_secret"); err == nil {
		t.Fatal("expected wrong secret to fail")
	}
}

func stripeSignature(payload []byte, secret string, at time.Time) string {
	timestamp := at.Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(fmt.Sprintf("%d.%s", timestamp, payload)))
	return fmt.Sprintf("t=%d,v1=%s", timestamp, hex.EncodeToString(mac.Sum(nil)))
}

type recordingStore struct {
	MemoryStore
	checkoutRecords []CheckoutRecord
}

func (s *recordingStore) CreateCheckout(ctx context.Context, record CheckoutRecord) (CheckoutRecord, error) {
	s.checkoutRecords = append(s.checkoutRecords, record)
	return record, nil
}
