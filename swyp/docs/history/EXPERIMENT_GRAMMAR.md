# Constrained Grammar Analysis: Formal Chomsky Hierarchy, Type Systems, and Semantic Correctness Without LLMs

## 1. Executive Summary

This document provides a formal theoretical and practical analysis of **constrained grammars without Large Language Models (LLMs)** in the context of the Swyp Lang architecture. We rigorously distinguish four distinct operational tiers:

1. **Regular Grammars / Finite State Machines (FSM)**: Chomsky Type-3 lexical scanning.
2. **Context-Free Grammars (CFG) / Pushdown Automata (PDA)**: Chomsky Type-2 recursive syntax parsing.
3. **Static Type Systems / Attribute Analysis**: Context-sensitive typing and scope binding ($\approx$ Chomsky Type-1).
4. **Operational Semantics & Verification**: Dynamic runtime behavior, termination bounds, and specification satisfaction.

We demonstrate that syntactic constraint mechanisms (whether CFG parsers or LLM grammar decoders) are fundamentally incapable of guaranteeing program validity or correctness on their own. Complete non-LLM autonomous synthesis requires layering CFG derivation with static type unification, resource-bounded evaluation, and inductive specification testing.

A standalone Go experiment verifying these tiers is implemented at [`experiments/grammar/main.go`](file:///D:/swyp%20lang/experiments/grammar/main.go).

---

## 2. Theoretical Foundations: The Grammar & Semantic Hierarchy

### 2.1 Regular Grammars / FSM (Chomsky Type-3)
- **Automaton Model**: Deterministic or Nondeterministic Finite Automata (DFA/NFA) with $O(1)$ memory.
- **Production Rules**: $A \to a B$ or $A \to a$ (right-linear).
- **Linguistic Power**: Recognizes regular expressions, identifiers, numeric literals, keywords, whitespace, and single-level delimiters.
- **Fundamental Limit**: The **Pumping Lemma for Regular Languages** states that for any regular language $L$, there exists a pumping length $p$ such that any string $s \in L$ with $|s| \ge p$ can be partitioned as $s = xyz$ where $|xy| \le p$, $|y| > 0$, and for all $i \ge 0$, $x y^i z \in L$.
- **Consequence**: An FSM cannot recognize languages requiring memory of unbounded nested depth, such as matched parentheses $L_{paren} = \{ (^n )^n \mid n \ge 1 \}$ or nested expressions.

### 2.2 Context-Free Grammars / Pushdown Automata (Chomsky Type-2)
- **Automaton Model**: Pushdown Automata (PDA) equipped with a last-in-first-out (LIFO) stack.
- **Production Rules**: $A \to \alpha$ where $A \in V_N$ and $\alpha \in (V_N \cup V_T)^*$.
- **Linguistic Power**: Recursive descent parsers, precedence climbing, LR/LALR/LL grammars. Represents recursive expression nesting:
  $$E \to E + T \mid E - T \mid T$$
  $$T \to T * F \mid T / F \mid F$$
  $$F \to ( E ) \mid \text{ident} \mid \text{literal}$$
- **Fundamental Limit**: CFGs define **pure structural shapes** (derivation trees). They cannot condition a production rule on distant context, such as whether an identifier was previously declared, or whether two subtrees produce compatible types. The language $\{ w c w \mid w \in \{a,b\}^* \}$ (representing variable declaration and use) is provably non-context-free via the Pumping Lemma for CFGs.

### 2.3 Static Type Checking (Context-Sensitive / Attribute Analysis)
- **Formal System**: Natural deduction typing judgments ($\Gamma \vdash e : \tau$).
- **Linguistic Power**: Enforces operator domains, type consistency, and variable scoping across AST nodes.
- **Distinction from CFG**:
  - `1 + 2`: Syntactically valid CFG, well-typed (`number + number -> number`).
  - `1 + true`: **Syntactically valid CFG**, but **ill-typed** (fails type unification).
  - `x + 1`: **Syntactically valid CFG**, but rejected if $x \notin \text{dom}(\Gamma)$ (unbound variable).
- In Chomsky's hierarchy, type systems and symbol-table scoping operate in context-sensitive territory (Chomsky Type-1 or attribute grammars).

### 2.4 Semantic Correctness vs. Type Soundness
- **Type Soundness (Wright & Felleisen, 1994)**: "Well-typed programs cannot get stuck." Formalized via **Progress** (a well-typed term is either a value or can take a step) and **Preservation / Subject Reduction** (if $\Gamma \vdash e : \tau$ and $e \to e'$, then $\Gamma \vdash e' : \tau$).
- **Type Soundness $\ne$ Semantic Correctness**:
  - A program can be syntactically valid and fully well-typed while being **semantically erroneous**:
    - **Runtime Arithmetic Faults**: `10 / 0` or non-finite operations (`NaN`, $\pm\infty$).
    - **Specification Divergence**: Candidate function returns $x + 1$, but user specification requires $2x + 1$.
    - **Resource Exhaustion**: Non-terminating infinite loops or unbounded recursion exceeding physical fuel/step limits.

---

## 3. Comparative Taxonomy

| Layer | Formal Model | Deciding Mechanism | What it Enforces | What it CANNOT Enforce |
| :--- | :--- | :--- | :--- | :--- |
| **Lexical** | Regular (Type-3) | Finite State Machine (DFA/NFA) | Valid token sequences, literal formats | Balanced parens, recursive nesting |
| **Syntactic** | Context-Free (Type-2) | Pushdown Automaton (Stack / Call frame) | Balanced delimiters, operator precedence, AST shape | Type safety, variable binding, arity |
| **Static Type** | Context-Sensitive (Type-1 / $\lambda$-calculus) | Unification / Hindley-Milner / Bidirectional inference | Type harmony, operator domain compatibility, variable scope | Zero-division avoidance, I/O correctness |
| **Semantic** | Operational Semantics | Concrete evaluation against I/O test harness | Specification matching, numeric finiteness, step bounds | Cannot statically prove termination in the general case (Halting problem) |

---

## 4. Swyp Lang 0.3: Concrete Implementation Analysis

Inspection of the Swyp compiler demonstrates strict boundaries between these layers:

1. **Regular / FSM Lexing**:
   - Location: [`internal/swyplang/swyp.go:48-99`](file:///D:/swyp%20lang/internal/swyplang/swyp.go#L48-L99).
   - Uses Go's `text/scanner` to emit tokens (`scanner.ScanIdents | scanner.ScanInts | scanner.ScanFloats | scanner.ScanStrings`). Reserved words (`fn`, `let`, `if`, etc.) are partitioned at token boundaries.
2. **Pushdown / Recursive CFG Parsing**:
   - Location: [`internal/swyplang/swyp.go:100-295`](file:///D:/swyp%20lang/internal/swyplang/swyp.go#L100-L295).
   - Implements precedence-climbing recursive descent ([`expression(min int)`](file:///D:/swyp%20lang/internal/swyplang/swyp.go#L240-L295)) backed by call stack frames.
   - Enforces an explicit pushdown recursion depth ceiling: `p.depth > 256` triggers panic `"syntax nesting limit exceeded"` ([`swyp.go:222-224`](file:///D:/swyp%20lang/internal/swyplang/swyp.go#L222-L224)).
3. **Context-Sensitive Type Checking**:
   - Location: [`internal/swyplang/check.go:1-286`](file:///D:/swyp%20lang/internal/swyplang/check.go#L1-L286).
   - Uses disjoint-set forests (union-find) over bitmasks (`numType=1`, `boolType=2`, `strType=4`, `voidType=8`) to unify types across identifiers, branches, and function signatures.
   - Rejects type mismatches (`mask == 0` in [`check.go:34-36`](file:///D:/swyp%20lang/internal/swyplang/check.go#L34-L36)).
4. **Semantic Interpreter with Bounded Fuel**:
   - Location: [`internal/swyplang/swyp.go:311-529`](file:///D:/swyp%20lang/internal/swyplang/swyp.go#L311-L529).
   - Enforces execution step budget (default 1,000,000 steps), call stack depth limit (128 frames), division-by-zero guards, and numeric finiteness checks (`math.IsNaN`, `math.IsInf`).

---

## 5. Non-LLM Constrained Synthesis vs. LLM Constrained Decoding

A critical architectural contrast exists between grammar-guided decoders in LLMs and deterministic non-LLM program synthesis:

1. **LLM Constrained Decoding (e.g. Outlines, Guidance, llama.cpp BNF/Grammar)**:
   - Modifies next-token softmax logits using a DFA or LR pushdown parser mask.
   - *Limitation*: Can only guarantee that output adheres to the CFG. It **cannot** guarantee that variables used in generated expressions were defined in earlier tokens, nor can it ensure that types align without running an external type checker post-generation.
   - If an LLM generates `x + 1` where `x` is undefined, the grammar constraint is fully satisfied, yet the program remains invalid.
2. **Deterministic Non-LLM Synthesis (SyGuS / Bottom-Up Enumeration)**:
   - As documented in [`docs/NON_LLM_ARCHITECTURE_REVIEW.md`](file:///D:/swyp%20lang/docs/NON_LLM_ARCHITECTURE_REVIEW.md), non-LLM inductive synthesis directly generates AST terms within bounded grammar rules:
     $$\text{Expr} ::= x \mid c \mid (\text{Expr} \odot \text{Expr})$$
   - Combines bottom-up grammar generation with **instant observational equivalence pruning**: candidate expressions are evaluated immediately against training pairs $(x_i, y_i)$, discarding redundant trees before type checking and compilation.
   - Guarantees $100\%$ syntactic validity, $100\%$ static type soundness, and $100\%$ semantic conformance against the supplied specification.

---

## 6. Standalone Verification Experiment (`experiments/grammar/main.go`)

To empirically validate these distinctions without modifying the compiler codebase, a standalone standard-library Go executable was created at [`experiments/grammar/main.go`](file:///D:/swyp%20lang/experiments/grammar/main.go).

### 6.1 Test Suites Executed
1. **Recursive CFG Expressions**: Validated parenthetical nesting `((1 + 2) * (3 - 4))`, deep recursion `((((5 + 5))))`, operator precedence `1 + 2 * 3 + 4`, boolean logic `!false && (true || false)`, and contextual environments `(x + 10) * (y - 2)`.
2. **Pushdown Rejection (Syntax Errors)**: Rejection of unbalanced opening `((1 + 2)`, unbalanced closing `(1 + 2))`, dangling operators `1 + * 2`, empty parens `()`, and exceeded recursion depth bounds (`depth 4 > max 3`).
3. **Type Checker Rejection (CFG Valid, Ill-Typed)**: Rejection of `1 + true`, `10 && 20`, unbound variables `unknown_var + 1`, and cross-type equality `5 == true`.
4. **Semantic Rejection (Well-Typed, Runtime Fault)**: Rejection of zero divisor `100 / (5 - 5)`.

### 6.2 Actual Execution Output
```
=== Constrained Grammar & Semantic Verification Experiment ===
Distinguishing: (1) Regular Lexing, (2) Recursive CFG Pushdown,
                (3) Context-Sensitive Typecheck, (4) Semantic Correctness.

Test  1: Nested recursive parens                [PASS] Accepted & Evaluated: ((1 + 2) * (3 - 4)) => -3 (number)
Test  2: Deep nesting within bound              [PASS] Accepted & Evaluated: ((((5 + 5)))) => 10 (number)
Test  3: Precedence climbing                    [PASS] Accepted & Evaluated: 1 + 2 * 3 + 4 => 11 (number)
Test  4: Recursive boolean expression           [PASS] Accepted & Evaluated: !false && (true || false) => true (bool)
Test  5: Variables with context environment     [PASS] Accepted & Evaluated: (x + 10) * (y - 2) => 60 (number)
Test  6: Unbalanced opening paren (CFG rejection) [PASS] Parser rejected malformed CFG: syntax error at pos 8: expected token type 8, got "<eof>"
Test  7: Unbalanced closing paren (CFG rejection) [PASS] Parser rejected malformed CFG: syntax error at pos 7: unexpected trailing token ")"
Test  8: Dangling binary operator (CFG rejection) [PASS] Parser rejected malformed CFG: syntax error at pos 4: unexpected token "*"
Test  9: Empty parentheses (CFG rejection)      [PASS] Parser rejected malformed CFG: syntax error at pos 1: unexpected token ")"
Test 10: Exceeded pushdown recursion depth bound [PASS] Parser rejected malformed CFG: nesting limit exceeded: depth 4 > max 3
Test 11: Add number to boolean (well-formed CFG, ill-typed) [PASS] Type checker caught mismatch: type error: operator "+" requires (number, number), got (number, bool)
Test 12: Logical AND on numbers (well-formed CFG, ill-typed) [PASS] Type checker caught mismatch: type error: operator "&&" requires (bool, bool), got (number, number)
Test 13: Undefined variable (well-formed CFG, unbound identifier) [PASS] Type checker caught mismatch: type error: undefined variable "unknown_var"
Test 14: Equality across mismatched types (number == bool) [PASS] Type checker caught mismatch: type error: operator '==' requires identical operand types, got (number, bool)
Test 15: Division by zero (well-typed number/number, semantic fault) [PASS] Semantic guard caught runtime fault: semantic error: division by zero guard triggered

Summary: 15 executed, 15 passed, 0 failed
```

---

## 7. Primary Literature Citations

1. **Chomsky, N.** (1956). *Three models for the description of language*. IRE Transactions on Information Theory, 2(3), 113–124. (Establishes Type-3 Regular, Type-2 Context-Free, Type-1 Context-Sensitive, and Type-0 unrestricted grammars).
2. **Hopcroft, J. E., Motwani, R., & Ullman, J. D.** (2006). *Introduction to Automata Theory, Languages, and Computation* (3rd ed.). Addison-Wesley. (Pumping lemmas for regular and context-free languages, pushdown automata mechanics).
3. **Aho, A. V., Lam, M. S., Sethi, R., & Ullman, J. D.** (2006). *Compilers: Principles, Techniques, and Tools* (2nd ed., "Dragon Book"). Addison-Wesley. (Lexical DFAs, LL/LR parsing, precedence climbing, syntax-directed translation, symbol tables).
4. **Pierce, B. C.** (2002). *Types and Programming Languages*. MIT Press. (Foundations of typed operational semantics, Hindley-Milner type inference, type safety).
5. **Wright, A. K., & Felleisen, M.** (1994). *A syntactic approach to type soundness*. *Information and Computation*, 115(1), 38–94. (Formal formulation of Progress and Preservation theorems).
6. **Gulwani, S., Polozov, O., & Singh, R.** (2017). *Program Synthesis*. *Foundations and Trends in Programming Languages*, 4(1-2), 1–119. (Syntax-Guided Synthesis - SyGuS, search space pruning via observational equivalence).
7. **Alur, R., et al.** (2013). *Syntax-guided synthesis*. In *Formal Methods in Computer-Aided Design (FMCAD 2013)*, IEEE, 1–8.
8. **Swyp Lang Internal Architecture**:
   - [`docs/NON_LLM_ARCHITECTURE_REVIEW.md`](file:///D:/swyp%20lang/docs/NON_LLM_ARCHITECTURE_REVIEW.md)
   - [`internal/swyplang/swyp.go`](file:///D:/swyp%20lang/internal/swyplang/swyp.go)
   - [`internal/swyplang/check.go`](file:///D:/swyp%20lang/internal/swyplang/check.go)
