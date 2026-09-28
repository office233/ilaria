package bridge

import (
	"context"
	"encoding/json"
	"swypik-os/core/docs"
	"swypik-os/core/ilaria"
	"swypik-os/core/notifications"
	"swypik-os/core/search"
	"swypik-os/core/sheets"
	"swypik-os/core/swarm"
)

// MobileBridge exposes the unified SwypikOS Go Core to Android via JNI / C-Shared / HTTP IPC.
type MobileBridge struct {
	Ilaria *ilaria.Engine
	Swarm  *swarm.Daemon
	Search *search.Engine
	Notifs *notifications.Broker
	Sheet  *sheets.Sheet
	DocMgr *docs.Manager
}

// NewMobileBridge initializes the unified cross-platform mobile bridge.
func NewMobileBridge() *MobileBridge {
	return &MobileBridge{
		Ilaria: ilaria.NewEngine(),
		Swarm:  swarm.NewDaemon(),
		Search: search.NewEngine(),
		Notifs: notifications.NewBroker(),
		Sheet:  sheets.NewSheet("Mobile AI Sheet", 20, 10),
		DocMgr: docs.NewManager(),
	}
}

// DispatchOmnibar processes user chat or voice transcripts from the bottom omnibar.
func (b *MobileBridge) DispatchOmnibar(input string) string {
	reply, err := b.Ilaria.ProcessPromptContext(context.Background(), input)
	if err != nil {
		reply = "Ilaria is unavailable: " + err.Error()
	}
	return reply
}

// QuerySearch executes an ad-free private search.
func (b *MobileBridge) QuerySearch(query string) string {
	res, err := b.Search.Search(query)
	if err != nil {
		return fmtErrorMessage(err)
	}
	bytes, err := json.Marshal(res)
	if err != nil {
		return fmtErrorMessage(err)
	}
	return string(bytes)
}

// GetSwarmStatus returns live mobile compute metrics.
func (b *MobileBridge) GetSwarmStatus() string {
	st := b.Swarm.GetStatus()
	bytes, err := json.Marshal(st)
	if err != nil {
		return fmtErrorMessage(err)
	}
	return string(bytes)
}

func fmtErrorMessage(err error) string {
	data, _ := json.Marshal(map[string]string{"error": err.Error()})
	return string(data)
}

// Close releases the background worker when the mobile bridge is no longer used.
func (b *MobileBridge) Close() { b.Swarm.Stop() }
