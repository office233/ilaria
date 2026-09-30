package notifications

import (
	"fmt"
	"testing"
)

func TestNotificationBroker(t *testing.T) {
	b := NewBroker()
	b.SetVIP("mama", true)

	// 1. Spam test
	nSpam := b.Ingest("delivery", "", "30% Discount voucher", "Order food now")
	if nSpam.Priority != PrioritySpam {
		t.Fatalf("Expected PrioritySpam, got %s", nSpam.Priority)
	}

	// 2. VIP test
	nVIP := b.Ingest("messenger", "Mama", "Hello", "Are you home?")
	if nVIP.Priority != PriorityUrgent {
		t.Fatalf("Expected PriorityUrgent for VIP, got %s", nVIP.Priority)
	}

	// 3. Digest test
	nDigest := b.Ingest("photos", "Friend", "New photo uploaded", "Check out the mountains")
	if nDigest.Priority != PriorityDigest {
		t.Fatalf("Expected PriorityDigest, got %s", nDigest.Priority)
	}

	summary, total := b.GetDigestSummary()
	if total != 1 {
		t.Errorf("Expected 1 item in digest, got %d", total)
	}
	if summary == "" {
		t.Errorf("Expected non-empty summary")
	}
}

func TestPhoneNotificationQueuesAreBounded(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	b := NewBroker()
	if b.maxQueue != 40 {
		t.Fatalf("maxQueue=%d want 40", b.maxQueue)
	}
	for i := 0; i < 100; i++ {
		b.Ingest("photos", "friend", fmt.Sprintf("update-%d", i), "body")
	}
	if got := len(b.digestQueue); got != 40 {
		t.Fatalf("digest queue=%d want 40", got)
	}
}
