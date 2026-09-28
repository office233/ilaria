// Package theme holds the Swypik design tokens, taken from the original
// desktop stylesheet (ui/web/desktop.css, "SwypikOS / Alabaster"). Colours
// are 0xRRGGBB; translucent CSS colours are 0xRRGGBBAA.
package theme

const (
	Background  = 0xF5F5FB // :root background
	Text        = 0x19182D // :root color
	Brand       = 0x7C3AED // --brand
	Muted       = 0x787D9B // --muted
	Line        = 0x8071B724
	Eyebrow     = 0x82769E
	TitleDot    = 0x9868F2
	RailIcon    = 0x484264
	Placeholder = 0x8589A5
	KbdText     = 0x8583A4
	KbdBorder   = 0xE2DEF0
	HintText    = 0x9991AC
	Footnote    = 0x9390AA
	CardArrow   = 0xBEB3D2
	PinnedHead  = 0x8A7F9F
	StatusDot   = 0x32B69A
	ChatLabel   = 0x7C3AED
	UserLabel   = 0x70677E
	ErrorText   = 0xA32950
	PanelLabel  = 0x9C8DB5
	Hover       = 0xEDE9FE

	// Ambient light and wallpaper arcs.
	AmbientLilac = 0xB3A2FF8C
	AmbientCyan  = 0xB7ECFC90
	AmbientRose  = 0xE7C8FF9C
	ArcStroke    = 0xFFFFFFBD
	ArcFrom      = 0xFFFFFF20
	ArcTo        = 0xFFFFFF03

	// Glass surfaces.
	CapsuleFrom = 0xFFFFFFF0
	CapsuleTo   = 0xFFFFFF8C
	MainFrom    = 0xFFFFFF99
	MainTo      = 0xFFFFFF75
	Content     = 0xFFFFFF45
	CardFrom    = 0xFFFFFFE0
	CardTo      = 0xFFFFFF80
	PillFrom    = 0xFFFFFFB0
	PillTo      = 0xFFFFFF65
	OmniFrom    = 0xFFFFFFD9
	OmniTo      = 0xFFFFFFA8
	OmniEdit    = 0xF8F6FB // opaque approximation for the native input field
	PanelBg     = 0xFCFBFFF5
	OverlayBg   = 0xF8F6FFFA

	// Shadows (colour with CSS alpha).
	ShadowMain    = 0x7B74BF55
	ShadowSoft    = 0x6D64B84A
	ShadowCard    = 0x8063C51C
	ShadowOmni    = 0x9A79E63B
	ShadowPanel   = 0x7965AE50
	ShadowOverlay = 0x59458040
)

// Tone is an app-symbol colour family: two gradient stops and the icon colour.
type Tone struct{ From, To, Icon uint32 }

var Tones = map[string]Tone{
	"violet": {0xF0E8FF, 0xE7DDFF, 0x7C3AED},
	"cyan":   {0xE0F6FC, 0xD4F0F7, 0x1490A8},
	"rose":   {0xFCE7F3, 0xF4E0FF, 0xB34D94},
	"amber":  {0xFCF0D9, 0xF9E7CC, 0xAD7B28},
	"ink":    {0xE9EDF6, 0xE0E5EE, 0x5C667D},
}
