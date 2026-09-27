package main

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Rect defines an axis-aligned bounding box.
type Rect struct {
	X, Y, W, H float64
}

func (r Rect) Right() float64  { return r.X + r.W }
func (r Rect) Bottom() float64 { return r.Y + r.H }

// Intersects checks if two rects overlap with non-zero area.
func (r Rect) Intersects(other Rect) bool {
	return !(r.Right() <= other.X || other.Right() <= r.X ||
		r.Bottom() <= other.Y || other.Bottom() <= r.Y)
}

// Element represents a single UI component in a dialog.
type Element struct {
	ID        string
	Kind      string // "label", "button", "input"
	Text      string
	IsAction  bool // clickable target requiring accessibility minimums
	Bounds    Rect // current layout bounds
	TextWidth float64
	TextHeight float64
}

// LayoutConfig holds dynamic layout parameters.
type LayoutConfig struct {
	ViewportW   float64
	ViewportH   float64
	FontScale   float64 // 1.0 = 100%, 1.5 = 150%, 2.0 = 200%
	BaseFontH   float64 // base font size in pixels (e.g. 14.0)
	CharWidthRatio float64 // average width per character relative to font height (~0.6)
	MinTouchTarget float64 // accessibility minimum target size (44.0 px)
	Padding     float64
	Spacing     float64
}

// MeasureText calculates bounded text dimensions under current font scaling.
func (cfg *LayoutConfig) MeasureText(text string) (float64, float64) {
	effectiveFontH := cfg.BaseFontH * cfg.FontScale
	charW := effectiveFontH * cfg.CharWidthRatio
	charCount := float64(utf8.RuneCountInString(text))
	return math.Ceil(charCount * charW), math.Ceil(effectiveFontH * 1.25)
}

// PrecomputedStaticLayout returns static, build-time baked bounds.
// Baked assuming English strings, 800x600 viewport, 1.0 font scale.
func PrecomputedStaticLayout() []Element {
	return []Element{
		{
			ID:       "title",
			Kind:     "label",
			Text:     "Account Settings",
			Bounds:   Rect{X: 20, Y: 20, W: 200, H: 24},
			IsAction: false,
		},
		{
			ID:       "desc",
			Kind:     "label",
			Text:     "Please review your profile preferences and confirm updates.",
			Bounds:   Rect{X: 20, Y: 54, W: 450, H: 20},
			IsAction: false,
		},
		{
			ID:       "input_label",
			Kind:     "label",
			Text:     "Username:",
			Bounds:   Rect{X: 20, Y: 90, W: 90, H: 20},
			IsAction: false,
		},
		{
			ID:       "input_field",
			Kind:     "input",
			Text:     "alex_developer_99",
			Bounds:   Rect{X: 120, Y: 86, W: 200, H: 28},
			IsAction: true,
		},
		{
			ID:       "btn_save",
			Kind:     "button",
			Text:     "Save Changes",
			Bounds:   Rect{X: 20, Y: 130, W: 110, H: 32},
			IsAction: true,
		},
		{
			ID:       "btn_cancel",
			Kind:     "button",
			Text:     "Cancel",
			Bounds:   Rect{X: 140, Y: 130, W: 80, H: 32},
			IsAction: true,
		},
	}
}

// DynamicComputeLayout performs a 2-pass responsive flow layout.
// Pass 1: Measure intrinsic size (text + padding + accessibility constraints).
// Pass 2: Layout & reflow according to viewport constraints.
func DynamicComputeLayout(elements []Element, cfg LayoutConfig) []Element {
	res := make([]Element, len(elements))
	copy(res, elements)

	pad := cfg.Padding
	spacing := cfg.Spacing
	curY := pad

	// Measure pass & place pass
	for i := range res {
		el := &res[i]
		tw, th := cfg.MeasureText(el.Text)
		el.TextWidth = tw
		el.TextHeight = th

		// Intrinsic dimensions with padding
		elemW := tw + pad*2
		elemH := th + pad*1.5

		// Apply accessibility minimum touch targets
		if el.IsAction {
			if elemW < cfg.MinTouchTarget {
				elemW = cfg.MinTouchTarget
			}
			if elemH < cfg.MinTouchTarget {
				elemH = cfg.MinTouchTarget
			}
		}

		// Responsive layout logic:
		// Title & description stack vertically
		if el.ID == "title" || el.ID == "desc" {
			// If text exceeds viewport, wrap or constrain width to viewport
			maxW := cfg.ViewportW - pad*2
			if elemW > maxW {
				// Multi-line wrap calculation
				lines := math.Ceil(elemW / maxW)
				elemW = maxW
				elemH = lines * th * 1.25 + pad
			}
			el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
			curY += elemH + spacing
			continue
		}

		// Form row: input_label and input_field
		if el.ID == "input_label" {
			inputW := 180.0 * cfg.FontScale
			neededRowW := pad*2 + elemW + spacing + inputW
			if neededRowW <= cfg.ViewportW {
				// Single row layout with input_field
				el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
			} else {
				// Stack vertically when viewport is narrow
				el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
				curY += elemH + spacing/2
			}
			continue
		}

		if el.ID == "input_field" {
			prev := res[i-1] // input_label
			if prev.Bounds.Y == curY {
				// Placed alongside label on the same row
				fieldX := prev.Bounds.Right() + spacing
				fieldW := math.Min(cfg.ViewportW-fieldX-pad, 200.0*cfg.FontScale)
				if fieldW < 80.0 {
					// Fallback to stacked if too narrow
					curY += prev.Bounds.H + spacing/2
					el.Bounds = Rect{X: pad, Y: curY, W: math.Min(cfg.ViewportW-pad*2, 240.0*cfg.FontScale), H: elemH}
					curY += elemH + spacing
				} else {
					el.Bounds = Rect{X: fieldX, Y: prev.Bounds.Y, W: fieldW, H: math.Max(prev.Bounds.H, elemH)}
					curY = el.Bounds.Bottom() + spacing
				}
			} else {
				// Stacked below label
				fieldW := math.Min(cfg.ViewportW-pad*2, 240.0*cfg.FontScale)
				el.Bounds = Rect{X: pad, Y: curY, W: fieldW, H: elemH}
				curY += elemH + spacing
			}
			continue
		}

		// Buttons: btn_save and btn_cancel
		if el.ID == "btn_save" {
			el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
			continue
		}

		if el.ID == "btn_cancel" {
			prev := res[i-1] // btn_save
			// Check if cancel button fits beside save button
			if prev.Bounds.Right()+spacing+elemW+pad <= cfg.ViewportW {
				el.Bounds = Rect{X: prev.Bounds.Right() + spacing, Y: prev.Bounds.Y, W: elemW, H: elemH}
				curY = math.Max(prev.Bounds.Bottom(), el.Bounds.Bottom()) + spacing
			} else {
				// Wrap button to next line
				curY = prev.Bounds.Bottom() + spacing
				el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
				curY += elemH + spacing
			}
			continue
		}

		// Fallback placement
		el.Bounds = Rect{X: pad, Y: curY, W: elemW, H: elemH}
		curY += elemH + spacing
	}

	return res
}

// AuditResult holds detection of layout violations.
type AuditResult struct {
	ClippingErrors int      // elements extending beyond viewport
	OverlapErrors  int      // elements colliding with other elements
	TextOverflows  int      // element bounds smaller than measured text
	A11ySizeErrors int      // interactive target smaller than minimum touch size (44px)
	Details        []string // error descriptions
}

// AuditLayout inspects an element layout against the viewport and text metrics.
func AuditLayout(elements []Element, cfg LayoutConfig) AuditResult {
	var res AuditResult

	for i, el := range elements {
		tw, th := cfg.MeasureText(el.Text)

		// 1. Viewport clipping
		if el.Bounds.Right() > cfg.ViewportW {
			res.ClippingErrors++
			res.Details = append(res.Details, fmt.Sprintf("[%s] clips right viewport (x2=%.1f > vp_w=%.1f)", el.ID, el.Bounds.Right(), cfg.ViewportW))
		}
		if el.Bounds.Bottom() > cfg.ViewportH {
			res.ClippingErrors++
			res.Details = append(res.Details, fmt.Sprintf("[%s] clips bottom viewport (y2=%.1f > vp_h=%.1f)", el.ID, el.Bounds.Bottom(), cfg.ViewportH))
		}

		// 2. Text overflow within bounding box
		// Distinguish single-line vs multi-line wrapped elements
		lineCapacity := math.Max(1.0, math.Floor(el.Bounds.H/(th*1.1)))
		if lineCapacity <= 1.0 {
			if tw > el.Bounds.W {
				res.TextOverflows++
				res.Details = append(res.Details, fmt.Sprintf("[%s] text overflow: text width %.1f exceeds box width %.1f ('%s')", el.ID, tw, el.Bounds.W, el.Text))
			}
		} else {
			if tw > (el.Bounds.W-cfg.Padding*2)*lineCapacity {
				res.TextOverflows++
				res.Details = append(res.Details, fmt.Sprintf("[%s] multi-line overflow: text width %.1f exceeds wrap capacity %.1f", el.ID, tw, (el.Bounds.W-cfg.Padding*2)*lineCapacity))
			}
		}
		if th > el.Bounds.H {
			res.TextOverflows++
			res.Details = append(res.Details, fmt.Sprintf("[%s] text height %.1f exceeds box height %.1f", el.ID, th, el.Bounds.H))
		}

		// 3. Accessibility minimum touch target
		if el.IsAction {
			if el.Bounds.W < cfg.MinTouchTarget || el.Bounds.H < cfg.MinTouchTarget {
				res.A11ySizeErrors++
				res.Details = append(res.Details, fmt.Sprintf("[%s] a11y target size violation: %.1fx%.1f < min %.1fx%.1f", el.ID, el.Bounds.W, el.Bounds.H, cfg.MinTouchTarget, cfg.MinTouchTarget))
			}
		}

		// 4. Overlap with sibling elements
		for j := i + 1; j < len(elements); j++ {
			other := elements[j]
			if el.Bounds.Intersects(other.Bounds) {
				res.OverlapErrors++
				res.Details = append(res.Details, fmt.Sprintf("[%s] overlaps [%s] (rectA: %+v, rectB: %+v)", el.ID, other.ID, el.Bounds, other.Bounds))
			}
		}
	}

	return res
}

func main() {
	fmt.Println("=================================================================")
	fmt.Println("  EXPERIMENT: Static Layout vs Dynamic Adaptive Layout Engine    ")
	fmt.Println("=================================================================")

	// Base Configuration
	baseCfg := LayoutConfig{
		ViewportW:      800,
		ViewportH:      600,
		FontScale:      1.0,
		BaseFontH:      14.0,
		CharWidthRatio: 0.6,
		MinTouchTarget: 44.0,
		Padding:        10.0,
		Spacing:        12.0,
	}

	// Baseline English Elements
	enElements := PrecomputedStaticLayout()

	// -------------------------------------------------------------
	// TEST 1: Baseline Default Condition (800x600, 1.0 Font, English)
	// -------------------------------------------------------------
	fmt.Println("\n--- TEST 1: Baseline English (800x600, 1.0 Scale) ---")
	auditStaticBase := AuditLayout(enElements, baseCfg)
	fmt.Printf("Static Precomputed Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditStaticBase.ClippingErrors, auditStaticBase.OverlapErrors, auditStaticBase.TextOverflows, auditStaticBase.A11ySizeErrors)

	dynBase := DynamicComputeLayout(enElements, baseCfg)
	auditDynBase := AuditLayout(dynBase, baseCfg)
	fmt.Printf("Dynamic Responsive Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditDynBase.ClippingErrors, auditDynBase.OverlapErrors, auditDynBase.TextOverflows, auditDynBase.A11ySizeErrors)

	// -------------------------------------------------------------
	// TEST 2: Viewport Resize (Shrink to 320x480 - Mobile / Tiled Window)
	// -------------------------------------------------------------
	fmt.Println("\n--- TEST 2: Viewport Resize (Shrink to 320x480) ---")
	shrinkCfg := baseCfg
	shrinkCfg.ViewportW = 320
	shrinkCfg.ViewportH = 480

	auditStaticShrink := AuditLayout(enElements, shrinkCfg)
	fmt.Printf("Static Precomputed Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditStaticShrink.ClippingErrors, auditStaticShrink.OverlapErrors, auditStaticShrink.TextOverflows, auditStaticShrink.A11ySizeErrors)
	for _, d := range auditStaticShrink.Details {
		if strings.Contains(d, "clips") {
			fmt.Println("  -> Defect:", d)
		}
	}

	dynShrink := DynamicComputeLayout(enElements, shrinkCfg)
	auditDynShrink := AuditLayout(dynShrink, shrinkCfg)
	fmt.Printf("Dynamic Responsive Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditDynShrink.ClippingErrors, auditDynShrink.OverlapErrors, auditDynShrink.TextOverflows, auditDynShrink.A11ySizeErrors)

	// -------------------------------------------------------------
	// TEST 3: Localization Expansion (German de-DE & Russian ru-RU)
	// -------------------------------------------------------------
	fmt.Println("\n--- TEST 3: Localization Expansion (German de-DE) ---")
	deElements := PrecomputedStaticLayout()
	// German translations expand significantly
	deElements[0].Text = "Kontoeinstellungen"                                                    // Account Settings
	deElements[1].Text = "Bitte überprüfen Sie Ihre Profileinstellungen und bestätigen Sie die Änderungen." // Please review...
	deElements[2].Text = "Benutzername:"                                                         // Username:
	deElements[4].Text = "Änderungen speichern"                                                  // Save Changes (110px box -> needs 150px+)
	deElements[5].Text = "Abbrechen"                                                             // Cancel

	auditStaticDe := AuditLayout(deElements, baseCfg)
	fmt.Printf("Static Precomputed Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditStaticDe.ClippingErrors, auditStaticDe.OverlapErrors, auditStaticDe.TextOverflows, auditStaticDe.A11ySizeErrors)
	for _, d := range auditStaticDe.Details {
		if strings.Contains(d, "text overflow") {
			fmt.Println("  -> Defect:", d)
		}
	}

	dynDe := DynamicComputeLayout(deElements, baseCfg)
	auditDynDe := AuditLayout(dynDe, baseCfg)
	fmt.Printf("Dynamic Responsive Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditDynDe.ClippingErrors, auditDynDe.OverlapErrors, auditDynDe.TextOverflows, auditDynDe.A11ySizeErrors)

	// -------------------------------------------------------------
	// TEST 4: Accessibility Font Scaling (200% Font Scale - WCAG 1.4.4)
	// -------------------------------------------------------------
	fmt.Println("\n--- TEST 4: Accessibility 200% Font Scale (WCAG 1.4.4) ---")
	a11yCfg := baseCfg
	a11yCfg.FontScale = 2.0 // 200% zoom

	auditStaticA11y := AuditLayout(enElements, a11yCfg)
	fmt.Printf("Static Precomputed Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditStaticA11y.ClippingErrors, auditStaticA11y.OverlapErrors, auditStaticA11y.TextOverflows, auditStaticA11y.A11ySizeErrors)
	for _, d := range auditStaticA11y.Details {
		if strings.Contains(d, "text overflow") {
			fmt.Println("  -> Defect:", d)
		}
	}

	dynA11y := DynamicComputeLayout(enElements, a11yCfg)
	auditDynA11y := AuditLayout(dynA11y, a11yCfg)
	fmt.Printf("Dynamic Responsive Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditDynA11y.ClippingErrors, auditDynA11y.OverlapErrors, auditDynA11y.TextOverflows, auditDynA11y.A11ySizeErrors)

	// -------------------------------------------------------------
	// TEST 5: Combined Stress Test (Narrow 360px + German + 150% Font Scale)
	// -------------------------------------------------------------
	fmt.Println("\n--- TEST 5: Combined Stress (360px Viewport + German + 1.5x Font) ---")
	stressCfg := baseCfg
	stressCfg.ViewportW = 360
	stressCfg.ViewportH = 640
	stressCfg.FontScale = 1.5

	auditStaticStress := AuditLayout(deElements, stressCfg)
	fmt.Printf("Static Precomputed Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditStaticStress.ClippingErrors, auditStaticStress.OverlapErrors, auditStaticStress.TextOverflows, auditStaticStress.A11ySizeErrors)

	dynStress := DynamicComputeLayout(deElements, stressCfg)
	auditDynStress := AuditLayout(dynStress, stressCfg)
	fmt.Printf("Dynamic Responsive Layout:  Clipping: %d, Overlaps: %d, TextOverflow: %d, A11yFail: %d\n",
		auditDynStress.ClippingErrors, auditDynStress.OverlapErrors, auditDynStress.TextOverflows, auditDynStress.A11ySizeErrors)

	// -------------------------------------------------------------
	// BENCHMARK: Computational Cost of Dynamic Layout Recomputation
	// -------------------------------------------------------------
	fmt.Println("\n--- BENCHMARK: Recompute Latency & Throughput ---")
	const iterations = 100_000

	// Benchmark Dynamic Recomputation
	startDyn := time.Now()
	for i := 0; i < iterations; i++ {
		_ = DynamicComputeLayout(deElements, stressCfg)
	}
	durDyn := time.Since(startDyn)
	nsPerOpDyn := durDyn.Nanoseconds() / iterations
	opsPerSecDyn := float64(iterations) / durDyn.Seconds()

	// Benchmark Static Table Lookup (Direct read)
	startStatic := time.Now()
	for i := 0; i < iterations; i++ {
		_ = PrecomputedStaticLayout()
	}
	durStatic := time.Since(startStatic)
	nsPerOpStatic := durStatic.Nanoseconds() / iterations
	opsPerSecStatic := float64(iterations) / durStatic.Seconds()

	fmt.Printf("Static Lookup:     %d iterations in %v -> %d ns/op (~%.0f ops/sec)\n",
		iterations, durStatic, nsPerOpStatic, opsPerSecStatic)
	fmt.Printf("Dynamic Recompute: %d iterations in %v -> %d ns/op (~%.0f ops/sec)\n",
		iterations, durDyn, nsPerOpDyn, opsPerSecDyn)
	fmt.Printf("Frame Budget (16.6ms @ 60fps): Dynamic recompute consumes ~%.4f%% of 1 frame\n",
		(float64(nsPerOpDyn) / 16_666_667.0) * 100.0)
	fmt.Printf("Frame Budget (8.33ms @ 120fps): Dynamic recompute consumes ~%.4f%% of 1 frame\n",
		(float64(nsPerOpDyn) / 8_333_333.0) * 100.0)

	fmt.Println("=================================================================")
}
