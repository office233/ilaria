"""Builds swyp/examples/swyp/tasks/tasks.jsonl: 60 Swyp contract tasks with reference solutions.

Each row: id, tier, split ("train" | "heldout"), task (plain English), contract (Swyp
contract JSON), reference (one Swyp Semantic Core function). Postconditions are
written in infix here and compiled to contract predicates; a lookup table is
expressed as one implication per entry ("n != 3 || result == 6") so a
counterexample names the single broken case instead of the whole table.

Every domain has at most 256 integer tuples, so `swyp judge` enumerates it
(verdict `exhaustive`). swyp/cmd/swyp/tasks_test.go runs judge on every
reference. The split is frozen: held-out tasks must never enter training data.

    python forge/swypforge/build_tasks.py            # rewrite the file
    python forge/swypforge/build_tasks.py --check    # fail if the file differs
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

NEXUS_ROOT = Path(__file__).resolve().parents[3]
OUT = NEXUS_ROOT / "swyp" / "examples" / "swyp" / "tasks" / "tasks.jsonl"
TIERS = ("arithmetic", "branches", "loops", "recursion", "multi_input")
MAX_CASES = 256

# ── infix predicate compiler ──

_TOKEN = re.compile(r"\s*(\d+|[A-Za-z_]\w*|==|!=|<=|>=|&&|\|\||[-+*/%<>()!])")
_BINARY = [("||", "or"), ("&&", "and"),
           ({"==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge"}, None),
           ({"+": "add", "-": "sub"}, None), ({"*": "mul", "/": "div", "%": "rem"}, None)]


def tokens(text):
    pos, out = 0, []
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m or m.end() == pos:
            if text[pos:].strip() == "":
                break
            raise ValueError(f"bad predicate near {text[pos:]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


def compile_pred(text):
    toks = tokens(text)
    i = 0

    def peek():
        return toks[i] if i < len(toks) else None

    def level(n):
        nonlocal i
        if n == len(_BINARY):
            return unary()
        left = level(n + 1)
        ops, name = _BINARY[n]
        table = ops if isinstance(ops, dict) else {ops: name}
        while peek() in table:
            op = table[toks[i]]
            i += 1
            left = {"op": op, "args": [left, level(n + 1)]}
            if n == 2:  # comparisons do not chain
                break
        return left

    def unary():
        nonlocal i
        t = peek()
        if t == "-":
            i += 1
            inner = unary()
            if "const" in inner:
                return {"const": {"type": "i64", "value": str(-int(inner["const"]["value"]))}}
            return {"op": "neg", "args": [inner]}
        if t == "!":
            i += 1
            return {"op": "not", "args": [unary()]}
        if t == "(":
            i += 1
            e = level(0)
            if peek() != ")":
                raise ValueError(f"missing ) in {text!r}")
            i += 1
            return e
        i += 1
        if t is None:
            raise ValueError(f"unexpected end of {text!r}")
        if t.isdigit():
            return {"const": {"type": "i64", "value": t}}
        return {"var": t}

    e = level(0)
    if i != len(toks):
        raise ValueError(f"trailing tokens in {text!r}: {toks[i:]}")
    return e


def table(var, mapping):
    """One implication per entry: '<var> != k || result == v'."""
    return [f"{var} != {k} || result == {v}" for k, v in mapping.items()]


# ── task definitions: (id, tier, heldout, inputs, ensures, max_steps, task, reference) ──

def I(name, lo, hi):
    return (name, lo, hi)


def fact(n):
    return 1 if n <= 1 else n * fact(n - 1)


def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


TASKS = [
    # arithmetic (12: 8 train, 4 held-out)
    ("double", "arithmetic", False, [I("x", -100, 100)], ["result == 2 * x"], 200,
     "Return twice x.", "fn double(x: i64) -> i64 {\n    return x * 2;\n}"),
    ("cube", "arithmetic", True, [I("x", -6, 6)], ["result == x * x * x"], 200,
     "Return x cubed (x times x times x).", "fn cube(x: i64) -> i64 {\n    return x * x * x;\n}"),
    ("triple_plus_one", "arithmetic", False, [I("x", -80, 80)], ["result == 3 * x + 1"], 200,
     "Return three times x plus one.", "fn triple_plus_one(x: i64) -> i64 {\n    return 3 * x + 1;\n}"),
    ("negate", "arithmetic", False, [I("x", -100, 100)], ["result == -x"], 200,
     "Return x with its sign flipped.", "fn negate(x: i64) -> i64 {\n    return -x;\n}"),
    ("half_down", "arithmetic", False, [I("x", 0, 200)], ["result == x / 2"], 200,
     "x is not negative. Return half of x, rounded down.", "fn half_down(x: i64) -> i64 {\n    return x / 2;\n}"),
    ("mod_three", "arithmetic", True, [I("x", 0, 200)], ["result == x % 3"], 200,
     "x is not negative. Return the remainder of x divided by 3.", "fn mod_three(x: i64) -> i64 {\n    return x % 3;\n}"),
    ("last_digit", "arithmetic", False, [I("x", 0, 255)], ["result == x % 10"], 200,
     "x is not negative. Return the last decimal digit of x.", "fn last_digit(x: i64) -> i64 {\n    return x % 10;\n}"),
    ("to_fahrenheit", "arithmetic", True, [I("c", -40, 100)], ["result == c * 9 / 5 + 32"], 200,
     "Convert c degrees Celsius to Fahrenheit as c * 9 / 5 + 32, using integer division.",
     "fn to_fahrenheit(c: i64) -> i64 {\n    return c * 9 / 5 + 32;\n}"),
    ("minutes_to_seconds", "arithmetic", False, [I("m", 0, 200)], ["result == m * 60"], 200,
     "Return how many seconds are in m minutes.", "fn minutes_to_seconds(m: i64) -> i64 {\n    return m * 60;\n}"),
    ("add_vat", "arithmetic", False, [I("price", 0, 200)], ["result == price * 119 / 100"], 200,
     "Return price with 19% VAT added, as price * 119 / 100 with integer division.",
     "fn add_vat(price: i64) -> i64 {\n    return price * 119 / 100;\n}"),
    ("square_minus_x", "arithmetic", True, [I("x", -15, 15)], ["result == x * x - x"], 200,
     "Return x squared minus x.", "fn square_minus_x(x: i64) -> i64 {\n    return x * x - x;\n}"),
    ("round_down_ten", "arithmetic", False, [I("x", 0, 200)], ["result == x - x % 10"], 200,
     "x is not negative. Round x down to a multiple of 10.",
     "fn round_down_ten(x: i64) -> i64 {\n    return x - x % 10;\n}"),

    # branches (15: 10 train, 5 held-out)
    ("absolute", "branches", True, [I("x", -50, 50)], ["result >= 0", "result == x || result == -x"], 200,
     "Return the absolute value of x.",
     "fn absolute(x: i64) -> i64 {\n    if x < 0 {\n        return -x;\n    }\n    return x;\n}"),
    ("sign", "branches", False, [I("x", -50, 50)],
     ["x <= 0 || result == 1", "x >= 0 || result == -1", "x != 0 || result == 0"], 200,
     "Return 1 if x is positive, -1 if x is negative, and 0 if x is zero.",
     "fn sign(x: i64) -> i64 {\n    if x > 0 {\n        return 1;\n    }\n    if x < 0 {\n        return -1;\n    }\n    return 0;\n}"),
    ("clamp_0_50", "branches", True, [I("x", -100, 100)],
     ["result >= 0", "result <= 50", "x < 0 || x > 50 || result == x", "x >= 0 || result == 0", "x <= 50 || result == 50"], 200,
     "Clamp x to the range 0 to 50: below 0 gives 0, above 50 gives 50, otherwise x.",
     "fn clamp_0_50(x: i64) -> i64 {\n    if x < 0 {\n        return 0;\n    }\n    if x > 50 {\n        return 50;\n    }\n    return x;\n}"),
    ("is_even", "branches", False, [I("x", -100, 100)], ["x % 2 != 0 || result == 1", "x % 2 == 0 || result == 0"], 200,
     "Return 1 if x is even and 0 if x is odd.",
     "fn is_even(x: i64) -> i64 {\n    if x % 2 == 0 {\n        return 1;\n    }\n    return 0;\n}"),
    ("is_odd", "branches", False, [I("x", -100, 100)], ["x % 2 == 0 || result == 1", "x % 2 != 0 || result == 0"], 200,
     "Return 1 if x is odd and 0 if x is even.",
     "fn is_odd(x: i64) -> i64 {\n    if x % 2 != 0 {\n        return 1;\n    }\n    return 0;\n}"),
    ("relu", "branches", False, [I("x", -100, 100)], ["result >= 0", "result >= x", "result == x || result == 0"], 200,
     "Return x if it is positive, otherwise 0.",
     "fn relu(x: i64) -> i64 {\n    if x > 0 {\n        return x;\n    }\n    return 0;\n}"),
    ("min_with_zero", "branches", False, [I("x", -100, 100)], ["result <= 0", "result <= x", "result == x || result == 0"], 200,
     "Return x if it is negative, otherwise 0.",
     "fn min_with_zero(x: i64) -> i64 {\n    if x < 0 {\n        return x;\n    }\n    return 0;\n}"),
    ("distance_to_ten", "branches", True, [I("x", -50, 50)], ["result >= 0", "result == x - 10 || result == 10 - x"], 200,
     "Return the distance between x and 10 (never negative).",
     "fn distance_to_ten(x: i64) -> i64 {\n    if x > 10 {\n        return x - 10;\n    }\n    return 10 - x;\n}"),
    ("grade", "branches", True, [I("score", 0, 100)],
     ["score < 90 || result == 3", "score < 70 || score >= 90 || result == 2",
      "score < 50 || score >= 70 || result == 1", "score >= 50 || result == 0"], 200,
     "Return 3 for a score of 90 or more, 2 for 70 to 89, 1 for 50 to 69, and 0 below 50.",
     "fn grade(score: i64) -> i64 {\n    if score >= 90 {\n        return 3;\n    }\n    if score >= 70 {\n        return 2;\n    }\n    if score >= 50 {\n        return 1;\n    }\n    return 0;\n}"),
    ("is_digit", "branches", False, [I("x", -20, 20)], ["x < 0 || x > 9 || result == 1", "(x >= 0 && x <= 9) || result == 0"], 200,
     "Return 1 if x is between 0 and 9 inclusive, otherwise 0.",
     "fn is_digit(x: i64) -> i64 {\n    if x >= 0 && x <= 9 {\n        return 1;\n    }\n    return 0;\n}"),
    ("cap_at_hundred", "branches", False, [I("x", 0, 200)], ["result <= 100", "result <= x", "result == x || result == 100"], 200,
     "Return x, but never more than 100.",
     "fn cap_at_hundred(x: i64) -> i64 {\n    if x > 100 {\n        return 100;\n    }\n    return x;\n}"),
    ("shipping_fee", "branches", False, [I("order", 0, 200)], ["order < 100 || result == 0", "order >= 100 || result == 15"], 200,
     "Shipping costs 15, but it is free (0) when order is 100 or more. Return the shipping fee.",
     "fn shipping_fee(order: i64) -> i64 {\n    if order >= 100 {\n        return 0;\n    }\n    return 15;\n}"),
    ("discount_price", "branches", False, [I("price", 0, 200)], ["price < 100 || result == price - 10", "price >= 100 || result == price"], 200,
     "Prices of 100 or more get 10 off. Return the price to pay.",
     "fn discount_price(price: i64) -> i64 {\n    if price >= 100 {\n        return price - 10;\n    }\n    return price;\n}"),
    ("above_five", "branches", False, [I("x", -50, 50)], ["x <= 5 || result == 1", "x > 5 || result == 0"], 200,
     "Return 1 if x is greater than 5, otherwise 0.",
     "fn above_five(x: i64) -> i64 {\n    if x > 5 {\n        return 1;\n    }\n    return 0;\n}"),
    ("flip_if_odd", "branches", True, [I("x", -50, 50)], ["x % 2 == 0 || result == -x", "x % 2 != 0 || result == x"], 200,
     "Return -x when x is odd and x when x is even.",
     "fn flip_if_odd(x: i64) -> i64 {\n    if x % 2 != 0 {\n        return -x;\n    }\n    return x;\n}"),

    # loops (15: 10 train, 5 held-out)
    ("sum_to", "loops", False, [I("n", 0, 40)], ["result * 2 == n * (n + 1)"], 5000,
     "Return the sum 1 + 2 + ... + n (zero when n is 0), using a while loop.",
     "fn sum_to(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        total = total + i;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("sum_squares", "loops", True, [I("n", 0, 30)], ["result * 6 == n * (n + 1) * (2 * n + 1)"], 5000,
     "Return 1*1 + 2*2 + ... + n*n (zero when n is 0).",
     "fn sum_squares(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        total = total + i * i;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("sum_odd", "loops", False, [I("n", 0, 40)], ["result == n * n"], 5000,
     "Return the sum of the first n odd numbers 1 + 3 + 5 + ... (zero when n is 0).",
     "fn sum_odd(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 0;\n    while i < n {\n        total = total + 2 * i + 1;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("sum_even", "loops", False, [I("n", 0, 40)], ["result == n * (n + 1)"], 5000,
     "Return the sum of the first n even numbers 2 + 4 + 6 + ... (zero when n is 0).",
     "fn sum_even(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        total = total + 2 * i;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("count_multiples_of_three", "loops", False, [I("n", 0, 200)], ["result == n / 3"], 5000,
     "Count how many numbers from 1 to n are divisible by 3.",
     "fn count_multiples_of_three(n: i64) -> i64 {\n    let count: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        if i % 3 == 0 {\n            count = count + 1;\n        }\n        i = i + 1;\n    }\n    return count;\n}"),
    ("digit_count", "loops", False, [I("n", 0, 255)], ["n >= 10 || result == 1", "n < 10 || n >= 100 || result == 2", "n < 100 || result == 3"], 5000,
     "n is not negative. Return how many decimal digits n has (0 has one digit).",
     "fn digit_count(n: i64) -> i64 {\n    let count: i64 = 1;\n    let rest: i64 = n / 10;\n    while rest > 0 {\n        count = count + 1;\n        rest = rest / 10;\n    }\n    return count;\n}"),
    ("digit_sum", "loops", True, [I("n", 0, 255)], ["result == n / 100 + n / 10 % 10 + n % 10"], 5000,
     "n is not negative. Return the sum of the decimal digits of n.",
     "fn digit_sum(n: i64) -> i64 {\n    let total: i64 = 0;\n    let rest: i64 = n;\n    while rest > 0 {\n        total = total + rest % 10;\n        rest = rest / 10;\n    }\n    return total;\n}"),
    ("power_of_two", "loops", True, [I("n", 0, 15)], table("n", {k: 2 ** k for k in range(16)}), 5000,
     "Return 2 raised to the power n, using a loop.",
     "fn power_of_two(n: i64) -> i64 {\n    let value: i64 = 1;\n    let i: i64 = 0;\n    while i < n {\n        value = value * 2;\n        i = i + 1;\n    }\n    return value;\n}"),
    ("factorial_loop", "loops", False, [I("n", 0, 10)], table("n", {k: fact(k) for k in range(11)}), 5000,
     "Return n factorial (1 * 2 * ... * n, and 1 when n is 0), using a while loop.",
     "fn factorial_loop(n: i64) -> i64 {\n    let product: i64 = 1;\n    let i: i64 = 2;\n    while i <= n {\n        product = product * i;\n        i = i + 1;\n    }\n    return product;\n}"),
    ("sum_multiples_of_five", "loops", False, [I("n", 0, 100)], ["result * 2 == 5 * (n / 5) * (n / 5 + 1)"], 5000,
     "Return the sum of all multiples of 5 from 5 up to n (zero when there are none).",
     "fn sum_multiples_of_five(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 5;\n    while i <= n {\n        total = total + i;\n        i = i + 5;\n    }\n    return total;\n}"),
    ("integer_sqrt", "loops", True, [I("n", 0, 255)], ["result >= 0", "result * result <= n", "(result + 1) * (result + 1) > n"], 5000,
     "n is not negative. Return the largest integer r such that r * r <= n.",
     "fn integer_sqrt(n: i64) -> i64 {\n    let r: i64 = 0;\n    while (r + 1) * (r + 1) <= n {\n        r = r + 1;\n    }\n    return r;\n}"),
    ("log2_floor", "loops", False, [I("n", 1, 255)],
     [f"n < {2 ** k} || n >= {2 ** (k + 1)} || result == {k}" for k in range(8)], 5000,
     "n is at least 1. Return how many times n can be halved (integer division by 2) before it reaches 1.",
     "fn log2_floor(n: i64) -> i64 {\n    let count: i64 = 0;\n    let rest: i64 = n;\n    while rest > 1 {\n        rest = rest / 2;\n        count = count + 1;\n    }\n    return count;\n}"),
    ("sum_cubes", "loops", False, [I("n", 0, 20)], ["result * 4 == n * n * (n + 1) * (n + 1)"], 5000,
     "Return 1*1*1 + 2*2*2 + ... + n*n*n (zero when n is 0).",
     "fn sum_cubes(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        total = total + i * i * i;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("sum_n_to_ten", "loops", False, [I("n", 1, 10)], ["result * 2 == 110 - (n - 1) * n"], 5000,
     "n is between 1 and 10. Return n + (n + 1) + ... + 10.",
     "fn sum_n_to_ten(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = n;\n    while i <= 10 {\n        total = total + i;\n        i = i + 1;\n    }\n    return total;\n}"),
    ("alternating_sum", "loops", True, [I("n", 0, 40)], ["n % 2 != 0 || result == -(n / 2)", "n % 2 == 0 || result == (n + 1) / 2"], 5000,
     "Return 1 - 2 + 3 - 4 + ... up to n (zero when n is 0).",
     "fn alternating_sum(n: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 1;\n    while i <= n {\n        if i % 2 == 1 {\n            total = total + i;\n        } else {\n            total = total - i;\n        }\n        i = i + 1;\n    }\n    return total;\n}"),

    # recursion (9: 6 train, 3 held-out)
    ("factorial", "recursion", False, [I("n", 0, 10)], table("n", {k: fact(k) for k in range(11)}), 5000,
     "Return n factorial (1 when n is 0), using recursion.",
     "fn factorial(n: i64) -> i64 {\n    if n <= 1 {\n        return 1;\n    }\n    return n * factorial(n - 1);\n}"),
    ("fib", "recursion", True, [I("n", 0, 15)], table("n", {k: fib(k) for k in range(16)}), 20000,
     "Return the n-th Fibonacci number, where fib(0) = 0 and fib(1) = 1, using recursion.",
     "fn fib(n: i64) -> i64 {\n    if n < 2 {\n        return n;\n    }\n    return fib(n - 1) + fib(n - 2);\n}"),
    ("sum_rec", "recursion", False, [I("n", 0, 40)], ["result * 2 == n * (n + 1)"], 5000,
     "Return 1 + 2 + ... + n (zero when n is 0), using recursion.",
     "fn sum_rec(n: i64) -> i64 {\n    if n == 0 {\n        return 0;\n    }\n    return n + sum_rec(n - 1);\n}"),
    ("power_of_three", "recursion", False, [I("n", 0, 12)], table("n", {k: 3 ** k for k in range(13)}), 5000,
     "Return 3 raised to the power n, using recursion.",
     "fn power_of_three(n: i64) -> i64 {\n    if n == 0 {\n        return 1;\n    }\n    return 3 * power_of_three(n - 1);\n}"),
    ("digital_root", "recursion", True, [I("n", 0, 255)], ["n != 0 || result == 0", "n == 0 || result == 1 + (n - 1) % 9"], 5000,
     "n is not negative. Repeatedly add the decimal digits of n until one digit remains, and return it.",
     "fn digital_root(n: i64) -> i64 {\n    if n < 10 {\n        return n;\n    }\n    return digital_root(n / 10 + n % 10);\n}"),
    ("digit_sum_rec", "recursion", False, [I("n", 0, 255)], ["result == n / 100 + n / 10 % 10 + n % 10"], 5000,
     "n is not negative. Return the sum of the decimal digits of n, using recursion.",
     "fn digit_sum_rec(n: i64) -> i64 {\n    if n == 0 {\n        return 0;\n    }\n    return n % 10 + digit_sum_rec(n / 10);\n}"),
    ("binary_length", "recursion", True, [I("n", 1, 255)],
     [f"n < {2 ** k} || n >= {2 ** (k + 1)} || result == {k + 1}" for k in range(8)], 5000,
     "n is at least 1. Return the number of binary digits of n, using recursion.",
     "fn binary_length(n: i64) -> i64 {\n    if n < 2 {\n        return 1;\n    }\n    return 1 + binary_length(n / 2);\n}"),
    ("even_rec", "recursion", False, [I("n", 0, 100)], ["n % 2 != 0 || result == 1", "n % 2 == 0 || result == 0"], 5000,
     "n is not negative. Return 1 if n is even and 0 if it is odd, using recursion on n - 2.",
     "fn even_rec(n: i64) -> i64 {\n    if n == 0 {\n        return 1;\n    }\n    if n == 1 {\n        return 0;\n    }\n    return even_rec(n - 2);\n}"),
    ("times_seven_rec", "recursion", False, [I("n", 0, 30)], ["result == 7 * n"], 5000,
     "n is not negative. Return 7 * n by adding 7 recursively, without multiplying.",
     "fn times_seven_rec(n: i64) -> i64 {\n    if n == 0 {\n        return 0;\n    }\n    return 7 + times_seven_rec(n - 1);\n}"),

    # multi-input (9: 6 train, 3 held-out)
    ("min2", "multi_input", False, [I("a", -7, 7), I("b", -7, 7)], ["result <= a", "result <= b", "result == a || result == b"], 200,
     "Return the smaller of a and b.",
     "fn min2(a: i64, b: i64) -> i64 {\n    if a < b {\n        return a;\n    }\n    return b;\n}"),
    ("max3", "multi_input", True, [I("a", -2, 3), I("b", -2, 3), I("c", -2, 3)],
     ["result >= a", "result >= b", "result >= c", "result == a || result == b || result == c"], 200,
     "Return the largest of a, b and c.",
     "fn max3(a: i64, b: i64, c: i64) -> i64 {\n    let m: i64 = a;\n    if b > m {\n        m = b;\n    }\n    if c > m {\n        m = c;\n    }\n    return m;\n}"),
    ("abs_diff", "multi_input", True, [I("a", -7, 7), I("b", -7, 7)], ["result >= 0", "result == a - b || result == b - a"], 200,
     "Return the absolute difference between a and b.",
     "fn abs_diff(a: i64, b: i64) -> i64 {\n    if a > b {\n        return a - b;\n    }\n    return b - a;\n}"),
    ("average2", "multi_input", False, [I("a", 0, 15), I("b", 0, 15)], ["result == (a + b) / 2"], 200,
     "a and b are not negative. Return their average, rounded down.",
     "fn average2(a: i64, b: i64) -> i64 {\n    return (a + b) / 2;\n}"),
    ("rect_area", "multi_input", False, [I("w", 0, 15), I("h", 0, 15)], ["result == w * h"], 200,
     "Return the area of a rectangle with width w and height h.",
     "fn rect_area(w: i64, h: i64) -> i64 {\n    return w * h;\n}"),
    ("rect_perimeter", "multi_input", False, [I("w", 0, 15), I("h", 0, 15)], ["result == 2 * (w + h)"], 200,
     "Return the perimeter of a rectangle with width w and height h.",
     "fn rect_perimeter(w: i64, h: i64) -> i64 {\n    return 2 * (w + h);\n}"),
    ("between", "multi_input", False, [I("x", 0, 9), I("lo", 0, 4), I("hi", 5, 9)],
     ["x < lo || x > hi || result == 1", "(x >= lo && x <= hi) || result == 0"], 200,
     "Return 1 if x is between lo and hi inclusive, otherwise 0.",
     "fn between(x: i64, lo: i64, hi: i64) -> i64 {\n    if x >= lo && x <= hi {\n        return 1;\n    }\n    return 0;\n}"),
    ("safe_div", "multi_input", True, [I("a", 0, 15), I("b", 0, 15)], ["b != 0 || result == 0", "b == 0 || result == a / b"], 200,
     "Return a divided by b with integer division, or 0 when b is 0.",
     "fn safe_div(a: i64, b: i64) -> i64 {\n    if b == 0 {\n        return 0;\n    }\n    return a / b;\n}"),
    ("multiply_loop", "multi_input", False, [I("a", 0, 15), I("b", 0, 15)], ["result == a * b"], 5000,
     "a and b are not negative. Return a times b by adding a to itself b times in a loop.",
     "fn multiply_loop(a: i64, b: i64) -> i64 {\n    let total: i64 = 0;\n    let i: i64 = 0;\n    while i < b {\n        total = total + a;\n        i = i + 1;\n    }\n    return total;\n}"),
]


def build():
    rows = []
    for tid, tier, heldout, inputs, ensures, max_steps, task, reference in TASKS:
        cases = 1
        for _, lo, hi in inputs:
            cases *= hi - lo + 1
        if cases > MAX_CASES:
            raise ValueError(f"{tid}: {cases} cases > {MAX_CASES}; judge would sample instead of enumerate")
        if tier not in TIERS:
            raise ValueError(f"{tid}: unknown tier {tier}")
        if not reference.startswith(f"fn {tid}("):
            raise ValueError(f"{tid}: reference must define fn {tid}")
        contract = {"version": 1, "entry": tid,
                    "inputs": [{"name": n, "type": "i64", "min": str(lo), "max": str(hi)} for n, lo, hi in inputs],
                    "ensures": [compile_pred(e) for e in ensures], "max_steps": max_steps}
        rows.append({"id": tid, "tier": tier, "split": "heldout" if heldout else "train", "cases": cases,
                     "task": task, "contract": contract, "reference": reference})
    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate task id")
    for tier in TIERS:
        n = sum(r["tier"] == tier for r in rows)
        h = sum(r["tier"] == tier and r["split"] == "heldout" for r in rows)
        if h * 3 != n:
            raise ValueError(f"{tier}: {h} held-out of {n}; the split must be one third per tier")
    return rows


def render(rows):
    return "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows).encode("utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    data = render(build())
    if a.check:
        if OUT.read_bytes() != data:
            sys.exit(f"{OUT} differs from the builder")
        print("tasks.jsonl matches the builder")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {len(data.splitlines())} tasks to {OUT}")


if __name__ == "__main__":
    main()
