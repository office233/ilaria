package notifications

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// PriorityLevel defines the cognitive importance of an alert.
type PriorityLevel string

const (
	PriorityUrgent PriorityLevel = "URGENT" // Calls, security, VIP alerts
	PriorityDigest PriorityLevel = "DIGEST" // Secondary notifications buffered for summary
	PrioritySpam   PriorityLevel = "SPAM"   // Marketing, promo, unwanted notifications suppressed
)

// Notification represents a classified notification event.
type Notification struct {
	ID        string        `json:"id"`
	SourceApp string        `json:"source_app"`
	Sender    string        `json:"sender,omitempty"`
	Title     string        `json:"title"`
	Body      string        `json:"body"`
	Priority  PriorityLevel `json:"priority"`
	Reason    string        `json:"reason"`
	TimeStr   string        `json:"time_str"`
}

// Broker manages real-time event filtering without user distraction.
type Broker struct {
	mu              sync.RWMutex
	urgentQueue     []Notification
	digestQueue     []Notification
	spamNeutralized int64
	vipSenders      map[string]bool
}

// NewBroker initializes a cognitive notification broker.
func NewBroker() *Broker {
	return &Broker{
		urgentQueue:     make([]Notification, 0),
		digestQueue:     make([]Notification, 0),
		vipSenders:      make(map[string]bool),
		spamNeutralized: 0, // Baseline neutralized
	}
}

// SetVIP marks a sender as high-priority.
func (b *Broker) SetVIP(sender string, isVIP bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.vipSenders[strings.ToLower(strings.TrimSpace(sender))] = isVIP
}

// Ingest evaluates and routes an incoming notification.
func (b *Broker) Ingest(source, sender, title, body string) Notification {
	b.mu.Lock()
	defer b.mu.Unlock()

	content := strings.ToLower(title + " " + body)
	senderLower := strings.ToLower(strings.TrimSpace(sender))

	priority := PriorityDigest
	reason := "Secondary background activity buffered"

	// 1. Check for promotional spam
	spamWords := []string{"discount", "voucher", "promo", "reducere", "oferta", "limited time", "cashback", "sale"}
	for _, w := range spamWords {
		if strings.Contains(content, w) {
			priority = PrioritySpam
			reason = fmt.Sprintf("Promotional spam blocked (%s)", w)
			b.spamNeutralized++
			return Notification{
				ID:        fmt.Sprintf("notif_%d", time.Now().UnixNano()),
				SourceApp: source,
				Sender:    sender,
				Title:     title,
				Body:      body,
				Priority:  priority,
				Reason:    reason,
				TimeStr:   time.Now().Format("15:04"),
			}
		}
	}

	// 2. Check for urgent alerts
	if senderLower != "" && b.vipSenders[senderLower] {
		priority = PriorityUrgent
		reason = "VIP Contact Priority"
	} else if strings.Contains(" "+content+" ", " call ") || strings.Contains(content, "apel") ||
		strings.Contains(content, "otp") || strings.Contains(content, "2fa") ||
		strings.Contains(content, "security") || strings.Contains(content, "securitate") {
		priority = PriorityUrgent
		reason = "Critical / Security Event"
	}

	notif := Notification{
		ID:        fmt.Sprintf("notif_%d", time.Now().UnixNano()),
		SourceApp: source,
		Sender:    sender,
		Title:     title,
		Body:      body,
		Priority:  priority,
		Reason:    reason,
		TimeStr:   time.Now().Format("15:04"),
	}

	if priority == PriorityUrgent {
		b.urgentQueue = append(b.urgentQueue, notif)
		if len(b.urgentQueue) > 200 {
			retained := make([]Notification, 200)
			copy(retained, b.urgentQueue[len(b.urgentQueue)-200:])
			b.urgentQueue = retained
		}
	} else {
		b.digestQueue = append(b.digestQueue, notif)
		if len(b.digestQueue) > 200 {
			retained := make([]Notification, 200)
			copy(retained, b.digestQueue[len(b.digestQueue)-200:])
			b.digestQueue = retained
		}
	}

	return notif
}

// GetUrgent returns active critical notifications.
func (b *Broker) GetUrgent() []Notification {
	b.mu.RLock()
	defer b.mu.RUnlock()
	res := make([]Notification, len(b.urgentQueue))
	copy(res, b.urgentQueue)
	return res
}

// GetDigestSummary returns a clean synthesized digest of buffered alerts.
func (b *Broker) GetDigestSummary() (string, int) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	total := len(b.digestQueue)
	if total == 0 {
		return "All activities up to date. Zero pending interruptions.", 0
	}
	return fmt.Sprintf("%d secondary updates buffered calmly in background. Zero noisy interruptions.", total), total
}

// GetSpamCount returns the number of blocked promotional notifications.
func (b *Broker) GetSpamCount() int64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.spamNeutralized
}
