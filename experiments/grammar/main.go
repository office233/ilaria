package main

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode"
)

// =============================================================================
// Layer 1: Regular / FSM Lexer (Chomsky Type-3)
// Tokens are regular languages recognized by finite-state scanning.
// Cannot recognize balanced/nested parentheses or recursive syntax.
// =============================================================================

type TokenType int

const (
	TokenEOF TokenType = iota
	TokenNum
	TokenIdent
	TokenPlus
	TokenMinus
	TokenStar
	TokenSlash
	TokenLParen
	TokenRParen
	TokenBang
	TokenEqualEqual
	TokenAndAnd
	TokenOrOr
)

type Token struct {
	Type TokenType
	Text string
	Pos  int
}

func Lex(src string) ([]Token, error) {
	var tokens []Token
	runes := []rune(src)
	n := len(runes)
	i := 0

	for i < n {
		c := runes[i]
		if unicode.IsSpace(c) {
			i++
			continue
		}
		pos := i
		switch c {
		case '+':
			tokens = append(tokens, Token{Type: TokenPlus, Text: "+", Pos: pos})
			i++
		case '-':
			tokens = append(tokens, Token{Type: TokenMinus, Text: "-", Pos: pos})
			i++
		case '*':
			tokens = append(tokens, Token{Type: TokenStar, Text: "*", Pos: pos})
			i++
		case '/':
			tokens = append(tokens, Token{Type: TokenSlash, Text: "/", Pos: pos})
			i++
		case '(':
			tokens = append(tokens, Token{Type: TokenLParen, Text: "(", Pos: pos})
			i++
		case ')':
			tokens = append(tokens, Token{Type: TokenRParen, Text: ")", Pos: pos})
			i++
		case '!':
			tokens = append(tokens, Token{Type: TokenBang, Text: "!", Pos: pos})
			i++
		case '=':
			if i+1 < n && runes[i+1] == '=' {
				tokens = append(tokens, Token{Type: TokenEqualEqual, Text: "==", Pos: pos})
				i += 2
			} else {
				return nil, fmt.Errorf("lexical error at pos %d: unexpected character '='", pos)
			}
		case '&':
			if i+1 < n && runes[i+1] == '&' {
				tokens = append(tokens, Token{Type: TokenAndAnd, Text: "&&", Pos: pos})
				i += 2
			} else {
				return nil, fmt.Errorf("lexical error at pos %d: unexpected character '&'", pos)
			}
		case '|':
			if i+1 < n && runes[i+1] == '|' {
				tokens = append(tokens, Token{Type: TokenOrOr, Text: "||", Pos: pos})
				i += 2
			} else {
				return nil, fmt.Errorf("lexical error at pos %d: unexpected character '|'", pos)
			}
		default:
			if unicode.IsDigit(c) {
				start := i
				for i < n && (unicode.IsDigit(runes[i]) || runes[i] == '.') {
					i++
				}
				txt := string(runes[start:i])
				tokens = append(tokens, Token{Type: TokenNum, Text: txt, Pos: pos})
			} else if unicode.IsLetter(c) || c == '_' {
				start := i
				for i < n && (unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i]) || runes[i] == '_') {
					i++
				}
				txt := string(runes[start:i])
				tokens = append(tokens, Token{Type: TokenIdent, Text: txt, Pos: pos})
			} else {
				return nil, fmt.Errorf("lexical error at pos %d: unknown character %q", pos, c)
			}
		}
	}
	tokens = append(tokens, Token{Type: TokenEOF, Text: "<eof>", Pos: n})
	return tokens, nil
}

// =============================================================================
// Layer 2: Recursive CFG / Pushdown Automaton (Chomsky Type-2)
// Context-Free Grammar for recursive expressions.
// Requires stack / recursive call frames (depth bounded).
// Handles arbitrary parenthetical nesting and operator precedence.
// =============================================================================

type ASTNode interface {
	isAST()
	String() string
}

type NumberLit struct {
	Value float64
}

func (NumberLit) isAST() {}
func (n NumberLit) String() string {
	return strconv.FormatFloat(n.Value, 'f', -1, 64)
}

type BoolLit struct {
	Value bool
}

func (BoolLit) isAST() {}
func (b BoolLit) String() string {
	return strconv.FormatBool(b.Value)
}

type VarExpr struct {
	Name string
}

func (VarExpr) isAST() {}
func (v VarExpr) String() string {
	return v.Name
}

type UnaryExpr struct {
	Op   string
	Expr ASTNode
}

func (UnaryExpr) isAST() {}
func (u UnaryExpr) String() string {
	return fmt.Sprintf("(%s%s)", u.Op, u.Expr.String())
}

type BinaryExpr struct {
	Op    string
	Left  ASTNode
	Right ASTNode
}

func (BinaryExpr) isAST() {}
func (b BinaryExpr) String() string {
	return fmt.Sprintf("(%s %s %s)", b.Left.String(), b.Op, b.Right.String())
}

type Parser struct {
	tokens   []Token
	pos      int
	depth    int
	maxDepth int
}

func NewParser(tokens []Token, maxDepth int) *Parser {
	return &Parser{tokens: tokens, pos: 0, depth: 0, maxDepth: maxDepth}
}

func (p *Parser) peek() Token {
	if p.pos >= len(p.tokens) {
		return Token{Type: TokenEOF, Text: "<eof>"}
	}
	return p.tokens[p.pos]
}

func (p *Parser) consume() Token {
	t := p.peek()
	if p.pos < len(p.tokens) {
		p.pos++
	}
	return t
}

func (p *Parser) expect(t TokenType) (Token, error) {
	curr := p.peek()
	if curr.Type != t {
		return curr, fmt.Errorf("syntax error at pos %d: expected token type %v, got %q", curr.Pos, t, curr.Text)
	}
	return p.consume(), nil
}

func (p *Parser) Parse() (ASTNode, error) {
	node, err := p.parseLogicalOr()
	if err != nil {
		return nil, err
	}
	if p.peek().Type != TokenEOF {
		return nil, fmt.Errorf("syntax error at pos %d: unexpected trailing token %q", p.peek().Pos, p.peek().Text)
	}
	return node, nil
}

func (p *Parser) enter() error {
	p.depth++
	if p.maxDepth > 0 && p.depth > p.maxDepth {
		return fmt.Errorf("nesting limit exceeded: depth %d > max %d", p.depth, p.maxDepth)
	}
	return nil
}

func (p *Parser) leave() {
	p.depth--
}

func (p *Parser) parseLogicalOr() (ASTNode, error) {
	left, err := p.parseLogicalAnd()
	if err != nil {
		return nil, err
	}
	for p.peek().Type == TokenOrOr {
		p.consume()
		right, err := p.parseLogicalAnd()
		if err != nil {
			return nil, err
		}
		left = BinaryExpr{Op: "||", Left: left, Right: right}
	}
	return left, nil
}

func (p *Parser) parseLogicalAnd() (ASTNode, error) {
	left, err := p.parseEquality()
	if err != nil {
		return nil, err
	}
	for p.peek().Type == TokenAndAnd {
		p.consume()
		right, err := p.parseEquality()
		if err != nil {
			return nil, err
		}
		left = BinaryExpr{Op: "&&", Left: left, Right: right}
	}
	return left, nil
}

func (p *Parser) parseEquality() (ASTNode, error) {
	left, err := p.parseAddSub()
	if err != nil {
		return nil, err
	}
	for p.peek().Type == TokenEqualEqual {
		p.consume()
		right, err := p.parseAddSub()
		if err != nil {
			return nil, err
		}
		left = BinaryExpr{Op: "==", Left: left, Right: right}
	}
	return left, nil
}

func (p *Parser) parseAddSub() (ASTNode, error) {
	left, err := p.parseMulDiv()
	if err != nil {
		return nil, err
	}
	for p.peek().Type == TokenPlus || p.peek().Type == TokenMinus {
		op := p.consume().Text
		right, err := p.parseMulDiv()
		if err != nil {
			return nil, err
		}
		left = BinaryExpr{Op: op, Left: left, Right: right}
	}
	return left, nil
}

func (p *Parser) parseMulDiv() (ASTNode, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for p.peek().Type == TokenStar || p.peek().Type == TokenSlash {
		op := p.consume().Text
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		left = BinaryExpr{Op: op, Left: left, Right: right}
	}
	return left, nil
}

func (p *Parser) parseUnary() (ASTNode, error) {
	if p.peek().Type == TokenBang || p.peek().Type == TokenMinus {
		op := p.consume().Text
		sub, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return UnaryExpr{Op: op, Expr: sub}, nil
	}
	return p.parsePrimary()
}

func (p *Parser) parsePrimary() (ASTNode, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer p.leave()

	tok := p.peek()
	switch tok.Type {
	case TokenNum:
		p.consume()
		val, err := strconv.ParseFloat(tok.Text, 64)
		if err != nil {
			return nil, fmt.Errorf("malformed float %q at pos %d", tok.Text, tok.Pos)
		}
		return NumberLit{Value: val}, nil

	case TokenIdent:
		p.consume()
		switch tok.Text {
		case "true":
			return BoolLit{Value: true}, nil
		case "false":
			return BoolLit{Value: false}, nil
		default:
			return VarExpr{Name: tok.Text}, nil
		}

	case TokenLParen:
		p.consume()
		expr, err := p.parseLogicalOr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(TokenRParen); err != nil {
			return nil, err
		}
		return expr, nil

	default:
		return nil, fmt.Errorf("syntax error at pos %d: unexpected token %q", tok.Pos, tok.Text)
	}
}

// =============================================================================
// Layer 3: Static Type Checker (Context-Sensitive Semantics)
// Beyond CFG: enforces type agreement and variable scope resolution.
// Chomsky Type-1 / Attribute Grammar territory.
// =============================================================================

type Type int

const (
	TypeUnknown Type = iota
	TypeNumber
	TypeBool
)

func (t Type) String() string {
	switch t {
	case TypeNumber:
		return "number"
	case TypeBool:
		return "bool"
	default:
		return "unknown"
	}
}

type TypeEnv map[string]Type

func TypeCheck(node ASTNode, env TypeEnv) (Type, error) {
	switch n := node.(type) {
	case NumberLit:
		return TypeNumber, nil

	case BoolLit:
		return TypeBool, nil

	case VarExpr:
		t, ok := env[n.Name]
		if !ok {
			return TypeUnknown, fmt.Errorf("type error: undefined variable %q", n.Name)
		}
		return t, nil

	case UnaryExpr:
		subT, err := TypeCheck(n.Expr, env)
		if err != nil {
			return TypeUnknown, err
		}
		switch n.Op {
		case "-":
			if subT != TypeNumber {
				return TypeUnknown, fmt.Errorf("type error: unary '-' requires number, got %s", subT)
			}
			return TypeNumber, nil
		case "!":
			if subT != TypeBool {
				return TypeUnknown, fmt.Errorf("type error: unary '!' requires bool, got %s", subT)
			}
			return TypeBool, nil
		default:
			return TypeUnknown, fmt.Errorf("type error: unknown unary operator %q", n.Op)
		}

	case BinaryExpr:
		leftT, err := TypeCheck(n.Left, env)
		if err != nil {
			return TypeUnknown, err
		}
		rightT, err := TypeCheck(n.Right, env)
		if err != nil {
			return TypeUnknown, err
		}

		switch n.Op {
		case "+", "-", "*", "/":
			if leftT != TypeNumber || rightT != TypeNumber {
				return TypeUnknown, fmt.Errorf("type error: operator %q requires (number, number), got (%s, %s)", n.Op, leftT, rightT)
			}
			return TypeNumber, nil

		case "&&", "||":
			if leftT != TypeBool || rightT != TypeBool {
				return TypeUnknown, fmt.Errorf("type error: operator %q requires (bool, bool), got (%s, %s)", n.Op, leftT, rightT)
			}
			return TypeBool, nil

		case "==":
			if leftT != rightT {
				return TypeUnknown, fmt.Errorf("type error: operator '==' requires identical operand types, got (%s, %s)", leftT, rightT)
			}
			return TypeBool, nil

		default:
			return TypeUnknown, fmt.Errorf("type error: unknown binary operator %q", n.Op)
		}

	default:
		return TypeUnknown, fmt.Errorf("type error: unknown AST node %T", node)
	}
}

// =============================================================================
// Layer 4: Semantic Evaluator & Correctness Verification
// Type-soundness does not equal semantic correctness!
// Evaluates operational semantics, prevents runtime faults (div-by-zero, non-finite),
// and verifies conformance against inductive input/output specifications.
// =============================================================================

type Value struct {
	Type     Type
	NumVal   float64
	BoolVal  bool
}

func (v Value) String() string {
	if v.Type == TypeNumber {
		return strconv.FormatFloat(v.NumVal, 'f', -1, 64)
	}
	return strconv.FormatBool(v.BoolVal)
}

type ValueEnv map[string]Value

type EvalLimits struct {
	MaxSteps int
	Steps    int
}

func Evaluate(node ASTNode, env ValueEnv, limits *EvalLimits) (Value, error) {
	if limits != nil {
		limits.Steps++
		if limits.MaxSteps > 0 && limits.Steps > limits.MaxSteps {
			return Value{}, errors.New("semantic runtime error: step budget exhausted")
		}
	}

	switch n := node.(type) {
	case NumberLit:
		if math.IsNaN(n.Value) || math.IsInf(n.Value, 0) {
			return Value{}, errors.New("semantic error: non-finite float literal")
		}
		return Value{Type: TypeNumber, NumVal: n.Value}, nil

	case BoolLit:
		return Value{Type: TypeBool, BoolVal: n.Value}, nil

	case VarExpr:
		v, ok := env[n.Name]
		if !ok {
			return Value{}, fmt.Errorf("semantic runtime error: unbound variable %q", n.Name)
		}
		return v, nil

	case UnaryExpr:
		sub, err := Evaluate(n.Expr, env, limits)
		if err != nil {
			return Value{}, err
		}
		if n.Op == "-" {
			return Value{Type: TypeNumber, NumVal: -sub.NumVal}, nil
		} else if n.Op == "!" {
			return Value{Type: TypeBool, BoolVal: !sub.BoolVal}, nil
		}
		return Value{}, fmt.Errorf("semantic runtime error: invalid unary op %q", n.Op)

	case BinaryExpr:
		l, err := Evaluate(n.Left, env, limits)
		if err != nil {
			return Value{}, err
		}
		r, err := Evaluate(n.Right, env, limits)
		if err != nil {
			return Value{}, err
		}

		switch n.Op {
		case "+":
			res := l.NumVal + r.NumVal
			if math.IsNaN(res) || math.IsInf(res, 0) {
				return Value{}, errors.New("semantic error: arithmetic overflow/non-finite result")
			}
			return Value{Type: TypeNumber, NumVal: res}, nil
		case "-":
			res := l.NumVal - r.NumVal
			if math.IsNaN(res) || math.IsInf(res, 0) {
				return Value{}, errors.New("semantic error: arithmetic overflow/non-finite result")
			}
			return Value{Type: TypeNumber, NumVal: res}, nil
		case "*":
			res := l.NumVal * r.NumVal
			if math.IsNaN(res) || math.IsInf(res, 0) {
				return Value{}, errors.New("semantic error: arithmetic overflow/non-finite result")
			}
			return Value{Type: TypeNumber, NumVal: res}, nil
		case "/":
			if r.NumVal == 0 {
				return Value{}, errors.New("semantic error: division by zero guard triggered")
			}
			res := l.NumVal / r.NumVal
			if math.IsNaN(res) || math.IsInf(res, 0) {
				return Value{}, errors.New("semantic error: non-finite division result")
			}
			return Value{Type: TypeNumber, NumVal: res}, nil
		case "&&":
			return Value{Type: TypeBool, BoolVal: l.BoolVal && r.BoolVal}, nil
		case "||":
			return Value{Type: TypeBool, BoolVal: l.BoolVal || r.BoolVal}, nil
		case "==":
			if l.Type == TypeNumber {
				return Value{Type: TypeBool, BoolVal: l.NumVal == r.NumVal}, nil
			}
			return Value{Type: TypeBool, BoolVal: l.BoolVal == r.BoolVal}, nil
		default:
			return Value{}, fmt.Errorf("semantic runtime error: invalid binary op %q", n.Op)
		}

	default:
		return Value{}, fmt.Errorf("semantic runtime error: unexpected node type %T", node)
	}
}

// =============================================================================
// Verification Gate & Test Harness
// =============================================================================

type TestCase struct {
	Name        string
	Input       string
	TypeEnv     TypeEnv
	ValueEnv    ValueEnv
	ExpectParse bool
	ExpectType  bool
	ExpectSem   bool
	ExpectedVal string
	MaxDepth    int
}

func runTest(tc TestCase) (bool, string) {
	tokens, err := Lex(tc.Input)
	if err != nil {
		if !tc.ExpectParse {
			return true, fmt.Sprintf("[PASS] Lex rejected malformed input: %v", err)
		}
		return false, fmt.Sprintf("[FAIL] Unexpected lex failure: %v", err)
	}

	maxDepth := tc.MaxDepth
	if maxDepth == 0 {
		maxDepth = 32
	}
	parser := NewParser(tokens, maxDepth)
	ast, err := parser.Parse()
	if err != nil {
		if !tc.ExpectParse {
			return true, fmt.Sprintf("[PASS] Parser rejected malformed CFG: %v", err)
		}
		return false, fmt.Sprintf("[FAIL] Unexpected parse error: %v", err)
	}
	if !tc.ExpectParse {
		return false, "[FAIL] Expected parse failure, but parsing succeeded"
	}

	// Layer 3: Type check
	t, err := TypeCheck(ast, tc.TypeEnv)
	if err != nil {
		if !tc.ExpectType {
			return true, fmt.Sprintf("[PASS] Type checker caught mismatch: %v", err)
		}
		return false, fmt.Sprintf("[FAIL] Unexpected type check error: %v", err)
	}
	if !tc.ExpectType {
		return false, fmt.Sprintf("[FAIL] Expected type check failure, but got type %s", t)
	}

	// Layer 4: Semantic evaluation
	limits := &EvalLimits{MaxSteps: 1000}
	val, err := Evaluate(ast, tc.ValueEnv, limits)
	if err != nil {
		if !tc.ExpectSem {
			return true, fmt.Sprintf("[PASS] Semantic guard caught runtime fault: %v", err)
		}
		return false, fmt.Sprintf("[FAIL] Unexpected semantic eval error: %v", err)
	}
	if !tc.ExpectSem {
		return false, fmt.Sprintf("[FAIL] Expected semantic runtime fault, but evaluated to %s", val.String())
	}

	if tc.ExpectedVal != "" && val.String() != tc.ExpectedVal {
		return false, fmt.Sprintf("[FAIL] Semantic value mismatch: got %s, expected %s", val.String(), tc.ExpectedVal)
	}

	return true, fmt.Sprintf("[PASS] Accepted & Evaluated: %s => %s (%s)", tc.Input, val.String(), t.String())
}

func main() {
	fmt.Println("=== Constrained Grammar & Semantic Verification Experiment ===")
	fmt.Println("Distinguishing: (1) Regular Lexing, (2) Recursive CFG Pushdown,")
	fmt.Println("                (3) Context-Sensitive Typecheck, (4) Semantic Correctness.")
	fmt.Println()

	tests := []TestCase{
		// 1. Accepted recursive arithmetic expressions
		{
			Name:        "Nested recursive parens",
			Input:       "((1 + 2) * (3 - 4))",
			TypeEnv:     TypeEnv{},
			ValueEnv:    ValueEnv{},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   true,
			ExpectedVal: "-3",
		},
		{
			Name:        "Deep nesting within bound",
			Input:       "((((5 + 5))))",
			TypeEnv:     TypeEnv{},
			ValueEnv:    ValueEnv{},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   true,
			ExpectedVal: "10",
			MaxDepth:    10,
		},
		{
			Name:        "Precedence climbing",
			Input:       "1 + 2 * 3 + 4",
			TypeEnv:     TypeEnv{},
			ValueEnv:    ValueEnv{},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   true,
			ExpectedVal: "11",
		},
		{
			Name:        "Recursive boolean expression",
			Input:       "!false && (true || false)",
			TypeEnv:     TypeEnv{},
			ValueEnv:    ValueEnv{},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   true,
			ExpectedVal: "true",
		},
		{
			Name:        "Variables with context environment",
			Input:       "(x + 10) * (y - 2)",
			TypeEnv:     TypeEnv{"x": TypeNumber, "y": TypeNumber},
			ValueEnv:    ValueEnv{"x": Value{Type: TypeNumber, NumVal: 5}, "y": Value{Type: TypeNumber, NumVal: 6}},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   true,
			ExpectedVal: "60",
		},

		// 2. CFG pushdown rejection: Malformed syntax
		{
			Name:        "Unbalanced opening paren (CFG rejection)",
			Input:       "((1 + 2)",
			ExpectParse: false,
		},
		{
			Name:        "Unbalanced closing paren (CFG rejection)",
			Input:       "(1 + 2))",
			ExpectParse: false,
		},
		{
			Name:        "Dangling binary operator (CFG rejection)",
			Input:       "1 + * 2",
			ExpectParse: false,
		},
		{
			Name:        "Empty parentheses (CFG rejection)",
			Input:       "()",
			ExpectParse: false,
		},
		{
			Name:        "Exceeded pushdown recursion depth bound",
			Input:       "(((((1)))))",
			MaxDepth:    3,
			ExpectParse: false,
		},

		// 3. Type Checking rejections (Syntactically valid CFG, rejected by Type Checker)
		{
			Name:        "Add number to boolean (well-formed CFG, ill-typed)",
			Input:       "1 + true",
			TypeEnv:     TypeEnv{},
			ExpectParse: true,
			ExpectType:  false,
		},
		{
			Name:        "Logical AND on numbers (well-formed CFG, ill-typed)",
			Input:       "10 && 20",
			TypeEnv:     TypeEnv{},
			ExpectParse: true,
			ExpectType:  false,
		},
		{
			Name:        "Undefined variable (well-formed CFG, unbound identifier)",
			Input:       "unknown_var + 1",
			TypeEnv:     TypeEnv{},
			ExpectParse: true,
			ExpectType:  false,
		},
		{
			Name:        "Equality across mismatched types (number == bool)",
			Input:       "5 == true",
			TypeEnv:     TypeEnv{},
			ExpectParse: true,
			ExpectType:  false,
		},

		// 4. Semantic correctness rejections (Well-formed CFG, Well-typed, rejected by Runtime/Spec)
		{
			Name:        "Division by zero (well-typed number/number, semantic fault)",
			Input:       "100 / (5 - 5)",
			TypeEnv:     TypeEnv{},
			ValueEnv:    ValueEnv{},
			ExpectParse: true,
			ExpectType:  true,
			ExpectSem:   false,
		},
	}

	passed := 0
	failed := 0

	for i, tc := range tests {
		ok, msg := runTest(tc)
		if ok {
			passed++
			fmt.Printf("Test %2d: %-38s %s\n", i+1, tc.Name, msg)
		} else {
			failed++
			fmt.Printf("Test %2d: %-38s %s\n", i+1, tc.Name, msg)
		}
	}

	fmt.Println()
	fmt.Printf("Summary: %d executed, %d passed, %d failed\n", len(tests), passed, failed)
	if failed > 0 {
		panic(fmt.Sprintf("%d tests failed", failed))
	}
}
