// Package theme holds the desktop's design tokens as 0xRRGGBB values. The
// look follows the original Swypik design: a lavender canvas, frosted white
// panels, violet accents and soft colour tiles.
package theme

const (
	CanvasTop    = 0xF6F4FD
	CanvasBottom = 0xEEF0FB
	GlowViolet   = 0xC4B5FD
	GlowCyan     = 0xBAE6FD
	GlowPink     = 0xFBCFE8

	Panel       = 0xFFFFFF // drawn with alpha over the canvas
	PanelBorder = 0xE6E3F4
	Surface     = 0xFFFFFF
	SurfaceSoft = 0xF7F6FC
	Hover       = 0xF1EFFA
	Divider     = 0xECEAF5
	Shadow      = 0x4C3F8F

	TextPrimary   = 0x16152B
	TextSecondary = 0x5F5C78
	TextMuted     = 0x9C99B3
	TextOnAccent  = 0xFFFFFF

	Accent      = 0x7C3AED
	AccentLight = 0x8B5CF6
	AccentDark  = 0x6D28D9
	AccentSoft  = 0xEDE9FE

	ErrorBg     = 0xFEF2F2
	ErrorBorder = 0xFECACA
	ErrorText   = 0xB42318
	WarnBg      = 0xFFFBEB
	WarnBorder  = 0xFDE68A
	WarnText    = 0x92400E
	Online      = 0x22C55E
	Offline     = 0xF59E0B

	CodeBg   = 0x1C1A2E
	CodeText = 0xE7E5F4
)

// Tone is a tile colour family: soft background and strong foreground.
type Tone struct{ Bg, Fg uint32 }

var Tones = map[string]Tone{
	"violet": {0xEDE9FE, 0x7C3AED},
	"pink":   {0xFCE7F3, 0xDB2777},
	"cyan":   {0xE0F2FE, 0x0284C7},
	"amber":  {0xFEF3C7, 0xD97706},
	"green":  {0xDCFCE7, 0x16A34A},
	"slate":  {0xF1F5F9, 0x475569},
}
