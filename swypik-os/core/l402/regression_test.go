package l402

import (
	"testing"
	"time"
)

func TestSettlementIdempotenceAndIsolation(t *testing.T) {
	s := NewSettlementEngine(nil)
	c, pre, err := s.GenerateChallenge(25, "test")
	if err != nil {
		t.Fatal(err)
	}
	hash := c.Invoice.PaymentHash
	c.Invoice.AmountSats = 999
	for i := 0; i < 2; i++ {
		if err := s.SettleInvoice(hash, pre); err != nil {
			t.Fatal(err)
		}
	}
	count, total := s.GetMetrics()
	if count != 1 || total != 25 {
		t.Fatalf("incorrect accounting: %d %d", count, total)
	}
	c.Token.Caveats = []string{"tampered"}
	if ok, _ := s.VerifyL402Auth(c.Token, pre); ok {
		t.Fatal("tampered caveat accepted")
	}
}

func TestExpiredInvoiceRejected(t *testing.T) {
	s := NewSettlementEngine(nil)
	c, pre, err := s.GenerateChallenge(1, "test")
	if err != nil {
		t.Fatal(err)
	}
	s.invoices[c.Invoice.PaymentHash].ExpiresAt = time.Now().Add(-time.Second)
	if err := s.SettleInvoice(c.Invoice.PaymentHash, pre); err == nil {
		t.Fatal("expired invoice settled")
	}
	if _, _, err := s.GenerateChallenge(-1, "test"); err == nil {
		t.Fatal("negative invoice accepted")
	}
}
