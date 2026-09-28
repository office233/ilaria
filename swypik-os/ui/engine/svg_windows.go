//go:build windows

package engine

import (
	"math"
	"strconv"
	"strings"
)

// The Swypik icon set, copied from the original desktop's SVG symbols (24x24
// viewBox, 1.7px round strokes). A few icons the native desktop needs in
// addition are drawn in the same style.
type svgShape struct {
	path   string // SVG path data in viewBox units
	fill   bool
	scaleX float64 // optional horizontal transform (icon-link)
	dx     float64
}

var iconSources = map[string][]svgShape{
	"brand":    {{path: "M12 3 20 13h-5v8H9v-8H4Z", fill: true}},
	"grid":     {{path: rectPath(3, 3, 7, 7, 2)}, {path: rectPath(14, 3, 7, 7, 2)}, {path: rectPath(3, 14, 7, 7, 2)}, {path: rectPath(14, 14, 7, 7, 2)}},
	"folder":   {{path: "M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"}},
	"file":     {{path: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v7h7M8 14h8m-8 4h5"}},
	"globe":    {{path: circlePath(12, 12, 9, 9)}, {path: circlePath(12, 12, 4, 9)}, {path: "M3 12h18M4 7h16M4 17h16"}},
	"terminal": {{path: rectPath(2, 3, 20, 18, 4)}, {path: "m6 8 4 4-4 4m7 0h5"}},
	"spark":    {{path: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"}},
	"chat":     {{path: "M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4ZM8 10h8m-8 4h5"}},
	"user":     {{path: circlePath(12, 7, 4, 4)}, {path: "M4 22v-3a8 8 0 0 1 16 0v3"}},
	"link":     {{path: "m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2", scaleX: 0.85, dx: 2}},
	"search":   {{path: circlePath(10.5, 10.5, 6.5, 6.5)}, {path: "m16 16 5 5"}},
	"star":     {{path: "m12 2 3 6.5 7 1-5 5 1 7-6-3.5-6 3.5 1-7-5-5 7-1Z"}},
	"arrow":    {{path: "M5 12h14m-6-6 6 6-6 6"}},
	"up":       {{path: "M12 20V4m-6 6 6-6 6 6"}},
	"settings": {{path: "M4 7h16M4 17h16"}, {path: circlePath(9, 7, 3, 3)}, {path: circlePath(15, 17, 3, 3)}},
	// Additional icons in the same stroke style.
	"refresh":    {{path: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"}},
	"expand":     {{path: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"}},
	"fullscreen": {{path: "M3 8V5a2 2 0 0 1 2-2h3m8 0h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3m-8 0H5a2 2 0 0 1-2-2v-3"}},
	"close":      {{path: "M6 6l12 12M18 6 6 18"}},
	"info":       {{path: circlePath(12, 12, 9, 9)}, {path: "M12 11v6M12 7.5v.1"}},
	"alert":      {{path: circlePath(12, 12, 9, 9)}, {path: "M12 7v6M12 16.5v.1"}},
	"warning":    {{path: "M12 3 2 20h20ZM12 10v4M12 17v.1"}},
	"code":       {{path: "m8 8-4 4 4 4m8-8 4 4-4 4"}},
	"chip":       {{path: rectPath(6, 6, 12, 12, 2)}, {path: "M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4M18 9h4m-4 6h4"}},
	"stop":       {{path: rectPath(7, 7, 10, 10, 2), fill: true}},
	"check":      {{path: "m5 12 5 5 9-10"}},
	"back":       {{path: "M19 12H5m6-6-6 6 6 6"}},
}

func rectPath(x, y, w, h, r float64) string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	return "M" + f(x+r) + " " + f(y) + "H" + f(x+w-r) + "A" + f(r) + " " + f(r) + " 0 0 1 " + f(x+w) + " " + f(y+r) +
		"V" + f(y+h-r) + "A" + f(r) + " " + f(r) + " 0 0 1 " + f(x+w-r) + " " + f(y+h) +
		"H" + f(x+r) + "A" + f(r) + " " + f(r) + " 0 0 1 " + f(x) + " " + f(y+h-r) +
		"V" + f(y+r) + "A" + f(r) + " " + f(r) + " 0 0 1 " + f(x+r) + " " + f(y) + "Z"
}

func circlePath(cx, cy, rx, ry float64) string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	return "M" + f(cx-rx) + " " + f(cy) + "A" + f(rx) + " " + f(ry) + " 0 1 0 " + f(cx+rx) + " " + f(cy) +
		"A" + f(rx) + " " + f(ry) + " 0 1 0 " + f(cx-rx) + " " + f(cy) + "Z"
}

// pathOp is one drawing instruction in viewBox units: M, L, C or Z.
type pathOp struct {
	op  byte
	pts [6]float64
}

type icon struct {
	shapes [][]pathOp
	fills  []bool
}

var icons = func() map[string]icon {
	out := map[string]icon{}
	for name, shapes := range iconSources {
		var ic icon
		for _, sh := range shapes {
			ops := parsePath(sh.path)
			if sh.scaleX != 0 {
				for i := range ops {
					for j := 0; j < 6; j += 2 {
						ops[i].pts[j] = sh.dx + sh.scaleX*ops[i].pts[j]
					}
				}
			}
			ic.shapes = append(ic.shapes, ops)
			ic.fills = append(ic.fills, sh.fill)
		}
		out[name] = ic
	}
	return out
}()

// parsePath converts SVG path data to absolute moves, lines and cubics.
func parsePath(d string) []pathOp {
	toks := tokenizePath(d)
	var ops []pathOp
	var cx, cy, sx, sy, lcx, lcy float64
	var prev byte
	i := 0
	num := func() float64 {
		if i >= len(toks) {
			return 0
		}
		v, _ := strconv.ParseFloat(toks[i], 64)
		i++
		return v
	}
	isNum := func() bool { return i < len(toks) && !isCommand(toks[i]) }
	var cmd byte
	for i < len(toks) {
		if isCommand(toks[i]) {
			cmd = toks[i][0]
			i++
		} else if cmd == 'M' {
			cmd = 'L'
		} else if cmd == 'm' {
			cmd = 'l'
		}
		rel := cmd >= 'a'
		up := cmd &^ 0x20
		ox, oy := 0.0, 0.0
		if rel {
			ox, oy = cx, cy
		}
		switch up {
		case 'M':
			cx, cy = ox+num(), oy+num()
			sx, sy = cx, cy
			ops = append(ops, pathOp{op: 'M', pts: [6]float64{cx, cy}})
		case 'L':
			cx, cy = ox+num(), oy+num()
			ops = append(ops, pathOp{op: 'L', pts: [6]float64{cx, cy}})
		case 'H':
			cx = ox + num()
			ops = append(ops, pathOp{op: 'L', pts: [6]float64{cx, cy}})
		case 'V':
			cy = oy + num()
			ops = append(ops, pathOp{op: 'L', pts: [6]float64{cx, cy}})
		case 'C':
			x1, y1, x2, y2, x, y := ox+num(), oy+num(), ox+num(), oy+num(), ox+num(), oy+num()
			ops = append(ops, pathOp{op: 'C', pts: [6]float64{x1, y1, x2, y2, x, y}})
			lcx, lcy, cx, cy = x2, y2, x, y
		case 'S':
			x1, y1 := cx, cy
			if prev == 'C' || prev == 'S' {
				x1, y1 = 2*cx-lcx, 2*cy-lcy
			}
			x2, y2, x, y := ox+num(), oy+num(), ox+num(), oy+num()
			ops = append(ops, pathOp{op: 'C', pts: [6]float64{x1, y1, x2, y2, x, y}})
			lcx, lcy, cx, cy = x2, y2, x, y
		case 'Q':
			qx, qy, x, y := ox+num(), oy+num(), ox+num(), oy+num()
			ops = append(ops, pathOp{op: 'C', pts: [6]float64{cx + 2.0/3*(qx-cx), cy + 2.0/3*(qy-cy), x + 2.0/3*(qx-x), y + 2.0/3*(qy-y), x, y}})
			cx, cy = x, y
		case 'A':
			rx, ry, rot, large, sweep := num(), num(), num(), num(), num()
			x, y := ox+num(), oy+num()
			ops = append(ops, arcToCubics(cx, cy, rx, ry, rot, large != 0, sweep != 0, x, y)...)
			cx, cy = x, y
		case 'Z':
			ops = append(ops, pathOp{op: 'Z'})
			cx, cy = sx, sy
		default:
			i++ // unknown token: skip
		}
		prev = up
		// Numbers after a command repeat it (the outer loop keeps cmd).
		_ = isNum
	}
	return ops
}

func isCommand(t string) bool {
	return len(t) == 1 && strings.ContainsRune("MmLlHhVvCcSsQqAaZz", rune(t[0]))
}

func tokenizePath(d string) []string {
	var out []string
	b := []rune(d)
	for i := 0; i < len(b); {
		ch := b[i]
		switch {
		case ch == ' ' || ch == ',' || ch == '\n' || ch == '\t':
			i++
		case isCommand(string(ch)):
			out = append(out, string(ch))
			i++
		default:
			j := i
			if b[j] == '-' || b[j] == '+' {
				j++
			}
			dot := false
			for j < len(b) && ((b[j] >= '0' && b[j] <= '9') || (b[j] == '.' && !dot)) {
				if b[j] == '.' {
					dot = true
				}
				j++
			}
			if j < len(b) && (b[j] == 'e' || b[j] == 'E') {
				j++
				if j < len(b) && (b[j] == '-' || b[j] == '+') {
					j++
				}
				for j < len(b) && b[j] >= '0' && b[j] <= '9' {
					j++
				}
			}
			if j == i {
				i++
				continue
			}
			out = append(out, string(b[i:j]))
			i = j
		}
	}
	return out
}

// arcToCubics implements the SVG endpoint-to-centre arc conversion and splits
// the arc into cubic Bézier segments of at most 90 degrees.
func arcToCubics(x1, y1, rx, ry, phiDeg float64, large, sweep bool, x2, y2 float64) []pathOp {
	if rx == 0 || ry == 0 || (x1 == x2 && y1 == y2) {
		return []pathOp{{op: 'L', pts: [6]float64{x2, y2}}}
	}
	rx, ry = math.Abs(rx), math.Abs(ry)
	phi := phiDeg * math.Pi / 180
	cos, sin := math.Cos(phi), math.Sin(phi)
	dx, dy := (x1-x2)/2, (y1-y2)/2
	x1p := cos*dx + sin*dy
	y1p := -sin*dx + cos*dy
	if l := x1p*x1p/(rx*rx) + y1p*y1p/(ry*ry); l > 1 {
		rx, ry = rx*math.Sqrt(l), ry*math.Sqrt(l)
	}
	num := rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p
	den := rx*rx*y1p*y1p + ry*ry*x1p*x1p
	coef := 0.0
	if den != 0 && num > 0 {
		coef = math.Sqrt(num / den)
	}
	if large == sweep {
		coef = -coef
	}
	cxp, cyp := coef*rx*y1p/ry, -coef*ry*x1p/rx
	cx := cos*cxp - sin*cyp + (x1+x2)/2
	cy := sin*cxp + cos*cyp + (y1+y2)/2
	angle := func(ux, uy, vx, vy float64) float64 {
		a := math.Atan2(ux*vy-uy*vx, ux*vx+uy*vy)
		return a
	}
	t1 := angle(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry)
	dt := angle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry)
	if !sweep && dt > 0 {
		dt -= 2 * math.Pi
	} else if sweep && dt < 0 {
		dt += 2 * math.Pi
	}
	n := int(math.Ceil(math.Abs(dt) / (math.Pi / 2)))
	if n < 1 {
		n = 1
	}
	step := dt / float64(n)
	k := 4.0 / 3 * math.Tan(step/4)
	point := func(t float64) (float64, float64) {
		x, y := rx*math.Cos(t), ry*math.Sin(t)
		return cos*x - sin*y + cx, sin*x + cos*y + cy
	}
	deriv := func(t float64) (float64, float64) {
		x, y := -rx*math.Sin(t), ry*math.Cos(t)
		return cos*x - sin*y, sin*x + cos*y
	}
	var ops []pathOp
	t := t1
	for i := 0; i < n; i++ {
		ax, ay := point(t)
		bx, by := point(t + step)
		dax, day := deriv(t)
		dbx, dby := deriv(t + step)
		ops = append(ops, pathOp{op: 'C', pts: [6]float64{ax + k*dax, ay + k*day, bx - k*dbx, by - k*dby, bx, by}})
		t += step
	}
	ops[len(ops)-1].pts[4], ops[len(ops)-1].pts[5] = x2, y2
	return ops
}

// drawIcon renders a named icon into r (square) with the CSS stroke style.
func (c canvas) drawIcon(name string, r rect, color uintptr, strokeWidth float32) {
	ic, ok := icons[name]
	if !ok {
		ic = icons["spark"]
	}
	scale := float64(r.width()) / 24
	ox, oy := float64(r.Left), float64(r.Top)
	pt := func(x, y float64) (uintptr, uintptr) {
		return f32(float32(ox + x*scale)), f32(float32(oy + y*scale))
	}
	for si, ops := range ic.shapes {
		p := newPath()
		var cx, cy float64
		for _, o := range ops {
			switch o.op {
			case 'M':
				procGdipStartPathFigure.Call(p)
				cx, cy = o.pts[0], o.pts[1]
			case 'L':
				ax, ay := pt(cx, cy)
				bx, by := pt(o.pts[0], o.pts[1])
				procGdipAddPathLine.Call(p, ax, ay, bx, by)
				cx, cy = o.pts[0], o.pts[1]
			case 'C':
				ax, ay := pt(cx, cy)
				b1x, b1y := pt(o.pts[0], o.pts[1])
				b2x, b2y := pt(o.pts[2], o.pts[3])
				ex, ey := pt(o.pts[4], o.pts[5])
				procGdipAddPathBezier.Call(p, ax, ay, b1x, b1y, b2x, b2y, ex, ey)
				cx, cy = o.pts[4], o.pts[5]
			case 'Z':
				procGdipClosePathFigure.Call(p)
			}
		}
		if ic.fills[si] {
			b := solid(color)
			c.fillPath(p, b)
			procGdipDeleteBrush.Call(b)
		} else {
			c.strokePath(p, color, strokeWidth*float32(scale))
		}
		procGdipDeletePath.Call(p)
	}
}
