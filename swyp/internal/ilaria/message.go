// Package ilaria retains the optional legacy draft-generation transport.
// The compiler and interpreter do not require a running model service.
package ilaria

// Message contains the fields consumed by the chat transport. The desktop
// application's UI and audio types are deliberately not dependencies here.
type Message struct {
	Sender string `json:"sender"`
	Text   string `json:"text"`
}
