package cyber

import "testing"

func TestPhoneCyberHistoryIsBounded(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	o := NewOrchestrator(nil, nil)
	if o.maxHistory != 20 {
		t.Fatalf("maxHistory=%d want 20", o.maxHistory)
	}
	o.mu.Lock()
	for i := 0; i < 100; i++ {
		o.appendHistoryLocked(&ActuationResult{})
	}
	o.mu.Unlock()
	if got := len(o.history); got != 20 {
		t.Fatalf("history=%d want 20", got)
	}
}
