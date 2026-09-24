package cortex

// calc.go — a small, safe arithmetic evaluator for the "calc" chat tool
// (cortex/toolloop.go). It is a hand-written recursive-descent parser over
// a deliberately tiny grammar: no identifiers, no assignment, no function
// calls other than sqrt(), and therefore nothing that could be mistaken
// for code execution.
//
//	expr   := term (('+' | '-') term)*
//	term   := factor (('*' | '/') factor)*
//	factor := ('+' | '-') factor | power
//	power  := primary ('^' factor)?          // right-associative, binds
//	                                          // tighter than unary minus
//	                                          // (so "-3^2" is -9, not 9 —
//	                                          // matches Python's -3**2)
//	primary:= number | '(' expr ')' | "sqrt" '(' expr ')'
//
// Arithmetic runs on big.Float at a generous fixed precision so that
// integer products like 48213*9071 come back exact, while divisions,
// sqrt() and fractional powers still produce a sane decimal answer.
// EvalArithmetic is the only exported entry point.

import (
	"fmt"
	"math"
	"math/big"
	"strings"
	"unicode"
)

// calcPrecision is the big.Float mantissa precision in bits (~77 decimal
// digits) — enough headroom that ordinary calculator-sized integers and
// products round-trip exactly, without pretending to be arbitrary
// precision for pathological inputs (huge exponents are rejected below).
const calcPrecision = 256

// calcMaxIntExponent bounds "^" when the exponent is a whole number, so a
// request like "2^100000000" fails fast with a clear error instead of
// spinning on a huge repeated-squaring loop.
const calcMaxIntExponent = 100000

// EvalArithmetic evaluates a small arithmetic expression — + - * / ^,
// parentheses, unary +/-, and sqrt(x) — and returns its decimal string
// form. The error is a plain, model-readable message (no Go internals)
// so it can be fed straight back as a "Tool: error: ..." message.
func EvalArithmetic(expr string) (string, error) {
	p := &calcParser{src: []rune(strings.TrimSpace(expr))}
	if len(p.src) == 0 {
		return "", fmt.Errorf("empty expression")
	}
	v, err := p.parseExpr()
	if err != nil {
		return "", err
	}
	p.skipSpace()
	if p.pos != len(p.src) {
		return "", fmt.Errorf("unexpected input at position %d: %q", p.pos, string(p.src[p.pos:]))
	}
	return formatBigFloat(v), nil
}

type calcParser struct {
	src []rune
	pos int
}

func (p *calcParser) peek() rune {
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}

func (p *calcParser) skipSpace() {
	for p.pos < len(p.src) && unicode.IsSpace(p.src[p.pos]) {
		p.pos++
	}
}

func newCalcFloat() *big.Float {
	return new(big.Float).SetPrec(calcPrecision)
}

func (p *calcParser) parseExpr() (*big.Float, error) {
	v, err := p.parseTerm()
	if err != nil {
		return nil, err
	}
	for {
		p.skipSpace()
		switch p.peek() {
		case '+':
			p.pos++
			rhs, err := p.parseTerm()
			if err != nil {
				return nil, err
			}
			v = newCalcFloat().Add(v, rhs)
		case '-':
			p.pos++
			rhs, err := p.parseTerm()
			if err != nil {
				return nil, err
			}
			v = newCalcFloat().Sub(v, rhs)
		default:
			return v, nil
		}
	}
}

func (p *calcParser) parseTerm() (*big.Float, error) {
	v, err := p.parseFactor()
	if err != nil {
		return nil, err
	}
	for {
		p.skipSpace()
		switch p.peek() {
		case '*':
			p.pos++
			rhs, err := p.parseFactor()
			if err != nil {
				return nil, err
			}
			v = newCalcFloat().Mul(v, rhs)
		case '/':
			p.pos++
			rhs, err := p.parseFactor()
			if err != nil {
				return nil, err
			}
			if rhs.Sign() == 0 {
				return nil, fmt.Errorf("division by zero")
			}
			v = newCalcFloat().Quo(v, rhs)
		default:
			return v, nil
		}
	}
}

// parseFactor handles unary +/- (lower precedence than '^', higher than
// binary * and /) and otherwise falls through to power.
func (p *calcParser) parseFactor() (*big.Float, error) {
	p.skipSpace()
	switch p.peek() {
	case '+':
		p.pos++
		return p.parseFactor()
	case '-':
		p.pos++
		v, err := p.parseFactor()
		if err != nil {
			return nil, err
		}
		return newCalcFloat().Neg(v), nil
	default:
		return p.parsePower()
	}
}

func (p *calcParser) parsePower() (*big.Float, error) {
	v, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.peek() == '^' {
		p.pos++
		// The exponent may itself carry a leading unary (2^-1) and is
		// right-associative (2^3^2 == 2^(3^2)).
		rhs, err := p.parseFactor()
		if err != nil {
			return nil, err
		}
		return calcPow(v, rhs)
	}
	return v, nil
}

func (p *calcParser) parsePrimary() (*big.Float, error) {
	p.skipSpace()
	if p.pos >= len(p.src) {
		return nil, fmt.Errorf("unexpected end of expression")
	}
	switch {
	case p.peek() == '(':
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.peek() != ')' {
			return nil, fmt.Errorf("expected ')' at position %d", p.pos)
		}
		p.pos++
		return v, nil
	case p.sqrtAhead():
		p.pos += 4 // len("sqrt")
		p.skipSpace()
		if p.peek() != '(' {
			return nil, fmt.Errorf("expected '(' after sqrt")
		}
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.peek() != ')' {
			return nil, fmt.Errorf("expected ')' to close sqrt(")
		}
		p.pos++
		if v.Sign() < 0 {
			return nil, fmt.Errorf("sqrt of a negative number is not real")
		}
		return newCalcFloat().Sqrt(v), nil
	case unicode.IsDigit(p.peek()) || p.peek() == '.':
		return p.parseNumber()
	default:
		return nil, fmt.Errorf("unexpected character %q at position %d", p.peek(), p.pos)
	}
}

func (p *calcParser) sqrtAhead() bool {
	if p.pos+4 > len(p.src) {
		return false
	}
	return strings.EqualFold(string(p.src[p.pos:p.pos+4]), "sqrt")
}

func (p *calcParser) parseNumber() (*big.Float, error) {
	start := p.pos
	seenDot := false
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if unicode.IsDigit(c) {
			p.pos++
			continue
		}
		if c == '.' && !seenDot {
			seenDot = true
			p.pos++
			continue
		}
		break
	}
	s := string(p.src[start:p.pos])
	if s == "" || s == "." {
		return nil, fmt.Errorf("invalid number at position %d", start)
	}
	v, ok := newCalcFloat().SetString(s)
	if !ok {
		return nil, fmt.Errorf("invalid number %q", s)
	}
	return v, nil
}

// calcPow computes base^exp. Integer exponents within
// [-calcMaxIntExponent, calcMaxIntExponent] use exact repeated-squaring
// on big.Float (so e.g. 2^64 is exact); anything else (fractional
// exponents, or integer exponents that large) falls back to float64
// math.Pow, which is what a fractional/huge power realistically needs.
func calcPow(base, exp *big.Float) (*big.Float, error) {
	if exp.IsInt() {
		e, acc := exp.Int64()
		if acc == big.Exact && e >= -calcMaxIntExponent && e <= calcMaxIntExponent {
			return bigFloatIntPow(base, e)
		}
	}
	bf, _ := base.Float64()
	ef, _ := exp.Float64()
	if bf < 0 && ef != math.Trunc(ef) {
		return nil, fmt.Errorf("negative base with a fractional exponent is not a real number")
	}
	r := math.Pow(bf, ef)
	if math.IsNaN(r) {
		return nil, fmt.Errorf("power is not a real number")
	}
	if math.IsInf(r, 0) {
		return nil, fmt.Errorf("power result overflows")
	}
	return newCalcFloat().SetFloat64(r), nil
}

func bigFloatIntPow(base *big.Float, e int64) (*big.Float, error) {
	neg := e < 0
	if neg {
		e = -e
	}
	result := newCalcFloat().SetInt64(1)
	b := newCalcFloat().Copy(base)
	for e > 0 {
		if e&1 == 1 {
			result = newCalcFloat().Mul(result, b)
		}
		e >>= 1
		if e > 0 {
			b = newCalcFloat().Mul(b, b)
		}
	}
	if neg {
		if result.Sign() == 0 {
			return nil, fmt.Errorf("division by zero")
		}
		one := newCalcFloat().SetInt64(1)
		result = newCalcFloat().Quo(one, result)
	}
	return result, nil
}

// formatBigFloat renders v as a plain decimal string: an exact integer
// when v is one, otherwise fixed-point with up to 10 fractional digits
// and trailing zeros trimmed.
func formatBigFloat(v *big.Float) string {
	if v.IsInf() {
		if v.Sign() > 0 {
			return "+Inf"
		}
		return "-Inf"
	}
	if v.IsInt() {
		return v.Text('f', 0)
	}
	s := v.Text('f', 10)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimRight(s, ".")
	}
	if s == "" || s == "-" {
		s = "0"
	}
	return s
}
