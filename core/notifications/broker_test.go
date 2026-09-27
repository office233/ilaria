package notifications

import (
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
