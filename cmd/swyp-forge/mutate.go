package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Mutation operators applied to a verified reference solution. Each mutant
// changes exactly one site. Only mutants for which `swyp judge` returns a
// real counterexample become repair examples; everything else is discarded.

type mutant struct {
	Op     string
	Source string
}

var (
	swypToken   = regexp.MustCompile(`==|!=|<=|>=|->|&&|\|\||[<>+\-*/%]|\d+|[A-Za-z_]\w*|\S`)
	returnStmt  = regexp.MustCompile(`return ([^;]+);`)
	baseCaseIf  = regexp.MustCompile(`(?s)\n?[ \t]*if [^{]*\{\s*return [^;]*;\s*\}`)
	cmpInverse  = map[string]string{"<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "=="}
	cmpBoundary = map[string]string{"<": "<=", "<=": "<", ">": ">=", ">=": ">"}
	arithSwap   = map[string]string{"+": "-", "-": "+", "*": "+", "/": "*", "%": "/"}
)

type token struct {
	text       string
	start, end int
}

// bodyTokens tokenizes everything after the signature's opening brace, so the
// "->" of the signature and parameter names are never mutated.
func bodyTokens(src string) (int, []token) {
	open := strings.IndexByte(src, '{')
	if open < 0 {
		return -1, nil
	}
	var toks []token
	for _, loc := range swypToken.FindAllStringIndex(src[open+1:], -1) {
		toks = append(toks, token{src[open+1+loc[0] : open+1+loc[1]], open + 1 + loc[0], open + 1 + loc[1]})
	}
	return open, toks
}

func isOperand(t string) bool {
	switch t {
	case ")":
		return true
	case "return", "if", "while", "else", "let":
		return false // "return -x": the minus is unary
	}
	c := t[0]
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func replaceAt(src string, t token, with string) string {
	return src[:t.start] + with + src[t.end:]
}

// mutants returns every single-site mutant, in source order per operator.
func mutants(src string) []mutant {
	_, toks := bodyTokens(src)
	var out []mutant
	add := func(op, s string) {
		if s != src {
			out = append(out, mutant{op, s})
		}
	}
	for i, t := range toks {
		if inv, ok := cmpInverse[t.text]; ok {
			add("cmp_invert", replaceAt(src, t, inv))
		}
		if b, ok := cmpBoundary[t.text]; ok {
			add("cmp_boundary", replaceAt(src, t, b))
		}
		// Binary arithmetic only: the previous token must end an operand.
		if a, ok := arithSwap[t.text]; ok && i > 0 && isOperand(toks[i-1].text) {
			add("arith_swap", replaceAt(src, t, a))
		}
		if n, err := strconv.ParseInt(t.text, 10, 64); err == nil {
			add("const_plus_one", replaceAt(src, t, strconv.FormatInt(n+1, 10)))
			if n > 0 {
				add("const_minus_one", replaceAt(src, t, strconv.FormatInt(n-1, 10)))
			}
		}
	}
	if rs := returnStmt.FindAllStringSubmatchIndex(src, -1); len(rs) >= 2 {
		a, b := src[rs[0][2]:rs[0][3]], src[rs[1][2]:rs[1][3]]
		if a != b {
			swapped := src[:rs[0][2]] + b + src[rs[0][3]:rs[1][2]] + a + src[rs[1][3]:]
			add("swap_returns", swapped)
		}
	}
	if loc := baseCaseIf.FindStringIndex(src); loc != nil {
		add("drop_base_case", src[:loc[0]]+src[loc[1]:])
	}
	return out
}

var (
	returnSemicolon = regexp.MustCompile(`(return [^;\n]+);`)
	sequentialIf    = regexp.MustCompile(`\}\n(\s*)if `)
	selfAssign      = regexp.MustCompile(`(\b[A-Za-z_]\w*) = ([A-Za-z_]\w*) ([+\-*]) ([^;]+);`)
	typedLet        = regexp.MustCompile(`let ([A-Za-z_]\w*): i64 = `)
)

// syntaxMutants reproduce the habits behind most rejected replies in the
// 2026-09-28 held-out baseline (44 of 62 attempts were compile errors):
// Rust-style returns without ";", "else if", compound assignment, "let mut"
// and untyped (f64) locals. They are kept only when judge reports an error.
func syntaxMutants(src string) []mutant {
	var out []mutant
	add := func(op, s string) {
		if s != src {
			out = append(out, mutant{op, s})
		}
	}
	if loc := returnSemicolon.FindStringSubmatchIndex(src); loc != nil {
		add("missing_semicolon", src[:loc[0]]+src[loc[2]:loc[3]]+src[loc[1]:])
	}
	if loc := sequentialIf.FindStringSubmatchIndex(src); loc != nil {
		add("else_if", src[:loc[0]]+"} else if "+src[loc[1]:])
	}
	for _, m := range selfAssign.FindAllStringSubmatchIndex(src, -1) {
		if src[m[2]:m[3]] == src[m[4]:m[5]] {
			add("compound_assign", src[:m[0]]+src[m[2]:m[3]]+" "+src[m[6]:m[7]]+"= "+src[m[8]:m[9]]+";"+src[m[1]:])
			break
		}
	}
	if loc := typedLet.FindStringSubmatchIndex(src); loc != nil {
		add("let_mut", src[:loc[0]]+"let mut "+src[loc[2]:loc[3]]+": i64 = "+src[loc[1]:])
		add("untyped_let", src[:loc[0]]+"let "+src[loc[2]:loc[3]]+" = "+src[loc[1]:])
	}
	return out
}

// pickDiverse takes up to limit mutants, cycling through operators in a
// fixed order so one operator cannot crowd out the others.
func pickDiverse(ms []mutant, limit int) []mutant {
	byOp := map[string][]mutant{}
	var order []string
	for _, m := range ms {
		if _, ok := byOp[m.Op]; !ok {
			order = append(order, m.Op)
		}
		byOp[m.Op] = append(byOp[m.Op], m)
	}
	var out []mutant
	for round := 0; len(out) < limit; round++ {
		progressed := false
		for _, op := range order {
			if round < len(byOp[op]) && len(out) < limit {
				out = append(out, byOp[op][round])
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	return out
}

func fence(src string) string { return fmt.Sprintf("```swyp\n%s\n```", strings.TrimSpace(src)) }
