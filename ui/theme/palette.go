package theme

import (
	"image/color"
)

// Luxury design tokens matching the visionOS & macOS Sequoia spatial design.
var (
	// Canvas Background & Atmospheric Aurora
	ColorCanvasBase    = color.RGBA{R: 248, G: 250, B: 252, A: 255} // #f8fafc Porcelain
	ColorAuroraCyan    = color.RGBA{R: 224, G: 242, B: 254, A: 255} // #e0f2fe Soft Sky Glow
	ColorAuroraIndigo  = color.RGBA{R: 237, G: 233, B: 254, A: 255} // #ede9fe Soft Lavender Aura

	// Frosted Glass Surfaces
	ColorGlassSurface  = color.RGBA{R: 255, G: 255, B: 255, A: 255} // Pure White Card
	ColorGlassElevated = color.RGBA{R: 255, G: 255, B: 255, A: 255} // Pure White Floating Pill
	ColorGlassSubtle   = color.RGBA{R: 248, G: 250, B: 252, A: 255} // Inner Card Background
	ColorGlassHover    = color.RGBA{R: 241, G: 245, B: 249, A: 255} // Light Gray Hover

	// Multi-layer Depth Shadows
	ColorShadowDeep    = color.RGBA{R: 203, G: 213, B: 225, A: 255} // #cbd5e1 Base shadow
	ColorShadowMid     = color.RGBA{R: 226, G: 232, B: 240, A: 255} // #e2e8f0 Mid shadow
	ColorShadowSoft    = color.RGBA{R: 241, G: 245, B: 249, A: 255} // #f1f5f9 Ambient shadow

	// Borders & Specular Highlights
	ColorBorderGlass   = color.RGBA{R: 226, G: 232, B: 240, A: 255} // #e2e8f0 Ultra-crisp border
	ColorBorderRim     = color.RGBA{R: 255, G: 255, B: 255, A: 255} // Pure White Specular Rim
	ColorBorderActive  = color.RGBA{R: 99, G: 102, B: 241, A: 255}  // #6366f1 Active Accent Border

	// High-Contrast Refined Typography
	ColorTextPrimary   = color.RGBA{R: 15, G: 23, B: 42, A: 255}   // #0f172a Deep Obsidian
	ColorTextSecondary = color.RGBA{R: 71, G: 85, B: 105, A: 255}  // #475569 Slate
	ColorTextMuted     = color.RGBA{R: 148, G: 163, B: 184, A: 255} // #94a3b8 Steel

	// Electric Spatial Accents
	ColorCyan          = color.RGBA{R: 14, G: 165, B: 233, A: 255}  // #0ea5e9 Electric Sky
	ColorCyanGlow      = color.RGBA{R: 186, G: 230, B: 253, A: 255} // #bae6fd Cyan Aura Ring
	ColorIndigo        = color.RGBA{R: 99, G: 102, B: 241, A: 255}  // #6366f1 Electric Indigo
	ColorIndigoGlow    = color.RGBA{R: 199, G: 210, B: 254, A: 255} // #c7d2fe Indigo Aura
	ColorEmerald       = color.RGBA{R: 16, G: 185, B: 129, A: 255}  // #10b981 Live Status Dot
	ColorGreenPill     = color.RGBA{R: 209, G: 250, B: 229, A: 255} // #d1fae5 Done Tag Bg
	ColorGreenText     = color.RGBA{R: 6, G: 95, B: 70, A: 255}     // #065f46 Done Tag Text

	// Window Controls (macOS style)
	ColorDotRed        = color.RGBA{R: 254, G: 96, B: 92, A: 255}   // Close
	ColorDotYellow     = color.RGBA{R: 254, G: 188, B: 46, A: 255}  // Minimize
	ColorDotGreen      = color.RGBA{R: 40, G: 200, B: 64, A: 255}   // Zoom

	// Semantic Aliases (used by native window render)
	ColorBgCore        = ColorCanvasBase    // Main canvas background
	ColorBgSurface     = ColorGlassSurface  // Frosted surface panels
	ColorBgElevated    = ColorGlassElevated // Elevated floating elements
	ColorBgCardHover   = ColorGlassHover    // Card hover state
)

// RGBToCOLORREF converts RGBA into standard Win32 COLORREF format (0x00BBGGRR).
func RGBToCOLORREF(c color.RGBA) uint32 {
	return uint32(c.R) | (uint32(c.G) << 8) | (uint32(c.B) << 16)
}
