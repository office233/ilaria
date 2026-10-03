package notifications

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	resourcepolicy "swypik-os/core/resource"
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
	maxQueue        int
}

// NewBroker initializes a cognitive notification broker.
func NewBroker() *Broker {
	policy := resourcepolicy.Default()
	maxQueue := policy.MaxChatHistoryMessages * 2
	if maxQueue < 40 {
		maxQueue = 40
	}
	if maxQueue > 200 {
		maxQueue = 200
	}
	return &Broker{
		urgentQueue:     make([]Notification, 0, min(maxQueue, 16)),
		digestQueue:     make([]Notification, 0, min(maxQueue, 16)),
		vipSenders:      make(map[string]bool),
		spamNeutralized: 0, // Baseline neutralized
		maxQueue:        maxQueue,
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

	// VIP and critical alerts take precedence over promotional words. An OTP
	// or security warning must not disappear merely because it mentions a sale.
	if senderLower != "" && b.vipSenders[senderLower] {
		priority = PriorityUrgent
		reason = "VIP Contact Priority"
	} else if containsKeyword(content, "call") || containsKeyword(content, "apel") ||
		containsKeyword(content, "otp") || containsKeyword(content, "2fa") ||
		containsKeyword(content, "security") || containsKeyword(content, "securitate") {
		priority = PriorityUrgent
		reason = "Critical / Security Event"
	}
	if priority != PriorityUrgent {
		for _, word := range []string{"discount", "voucher", "promo", "reducere", "oferta", "limited time", "cashback", "sale"} {
			if containsKeyword(content, word) {
				priority = PrioritySpam
				reason = fmt.Sprintf("Promotional spam blocked (%s)", word)
				b.spamNeutralized++
				break
			}
		}
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
		if len(b.urgentQueue) > b.maxQueue {
			copy(b.urgentQueue, b.urgentQueue[len(b.urgentQueue)-b.maxQueue:])
			b.urgentQueue = b.urgentQueue[:b.maxQueue]
		}
	} else if priority == PriorityDigest {
		b.digestQueue = append(b.digestQueue, notif)
		if len(b.digestQueue) > b.maxQueue {
			copy(b.digestQueue, b.digestQueue[len(b.digestQueue)-b.maxQueue:])
			b.digestQueue = b.digestQueue[:b.maxQueue]
		}
	}

	return notif
}

// Match complete words/phrases, including punctuation-separated words, without
// classifying e.g. "wholesale" or "recall" by a substring inside a larger word.
func containsKeyword(content, keyword string) bool {
	words := strings.FieldsFunc(content, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	return strings.Contains(" "+strings.Join(words, " ")+" ", " "+keyword+" ")
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
