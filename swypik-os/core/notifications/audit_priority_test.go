package notifications

import "testing"

func TestCriticalAlertsOverridePromotionalTerms(t *testing.T) {
	for _, test := range []struct{ sender, title, body string }{
		{"owner", "Discount voucher", "VIP offer"},
		{"bank", "Security alert", "Unauthorized purchase during sale"},
		{"bank", "OTP: 123456", "promo code is not an authorization code"},
		{"contact", "Incoming call!", "voucher"},
	} {
		b := NewBroker()
		b.SetVIP("owner", true)
		got := b.Ingest("test", test.sender, test.title, test.body)
		if got.Priority != PriorityUrgent || len(b.GetUrgent()) != 1 || b.GetSpamCount() != 0 {
			t.Fatalf("critical notification suppressed: %+v", got)
		}
	}
}

func TestClassificationUsesWordBoundaries(t *testing.T) {
	b := NewBroker()
	for _, title := range []string{"wholesale inventory", "product recall", "hotpot dinner"} {
		if got := b.Ingest("test", "friend", title, ""); got.Priority != PriorityDigest {
			t.Fatalf("substring misclassified notification: %+v", got)
		}
	}
	if got := b.Ingest("test", "shop", "Sale!", "limited-time offer"); got.Priority != PrioritySpam {
		t.Fatalf("promotional notification not classified: %+v", got)
	}
}
