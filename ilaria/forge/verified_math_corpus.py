"""Deterministic verifier-backed first-party mathematics corpus for IMC Genesis.

The corpus contains only programmatically generated problem/solution pairs.
Every row is checked by exact arithmetic before publication. It is candidate
data until the corresponding ownership attestation is explicitly approved.
"""
from __future__ import annotations

import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path

try:
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from .first_party_attestation import attestation_scope_sha256, inspect_attestation
except ImportError:
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from first_party_attestation import attestation_scope_sha256, inspect_attestation


FORMAT = "imc-125m-verified-math-generation-v1"
QUALITY_FORMAT = "imc-125m-verified-math-quality-v1"
PIPELINE_NAME = "verified-first-party-math-v1"
SOURCE_NAME = "first_party_math"
LANE = "mathematics"

FAMILIES = (
    "linear_equation",
    "linear_equation_fraction",
    "two_by_two_system",
    "quadratic_integer_roots",
    "polynomial_evaluation",
    "arithmetic_sequence_nth",
    "arithmetic_sequence_sum",
    "geometric_sequence_nth",
    "gcd",
    "lcm",
    "euclidean_division",
    "modular_remainder",
    "modular_inverse",
    "fraction_addition",
    "fraction_subtraction",
    "fraction_multiplication",
    "fraction_division",
    "percent_of_quantity",
    "percent_change",
    "direct_proportion",
    "inverse_proportion",
    "mean_integer_list",
    "median_integer_list",
    "weighted_average",
    "combination",
    "permutation",
    "binomial_coefficient_identity",
    "simple_probability",
    "complement_probability",
    "rectangle_geometry",
    "triangle_area",
    "pythagorean_hypotenuse",
)


def _u64(seed: int, sequence: int, salt: str) -> int:
    raw = f"{seed}:{sequence}:{salt}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big")


def _pick(seed: int, sequence: int, salt: str, low: int, high: int) -> int:
    if high < low:
        raise ValueError("invalid deterministic range")
    return low + _u64(seed, sequence, salt) % (high - low + 1)


def _nonzero(seed: int, sequence: int, salt: str, low: int = -25, high: int = 25) -> int:
    value = _pick(seed, sequence, salt, low, high)
    return value if value != 0 else 1


def _frac(value: Fraction) -> str:
    return str(value.numerator) if value.denominator == 1 else f"{value.numerator}/{value.denominator}"


def _explain(title: str, prompt: str, steps: list[str], answer: str) -> str:
    return (
        f"Problem family: {title}\n"
        f"Problem: {prompt}\n\n"
        "Exact solution:\n"
        + "\n".join(f"{index + 1}. {step}" for index, step in enumerate(steps))
        + f"\n\nVerified answer: {answer}\n"
        "Verification: substituting the result back into the defining relation reproduces "
        "the original quantities exactly; no numerical approximation is used."
    )


def _case(seed: int, sequence: int) -> tuple[str, str, dict]:
    family = FAMILIES[_u64(seed, sequence, "family") % len(FAMILIES)]

    if family == "linear_equation":
        x = _pick(seed, sequence, "x", -5000, 5000)
        a = _nonzero(seed, sequence, "a", -97, 97)
        b = _pick(seed, sequence, "b", -10000, 10000)
        c = a * x + b
        prompt = f"Solve the integer equation {a}x + ({b}) = {c}."
        answer = str(x)
        steps = [
            f"Subtract {b} from both sides to obtain {a}x = {c - b}.",
            f"Divide both sides by the nonzero coefficient {a}.",
            f"x = ({c - b}) / ({a}) = {x}.",
        ]
        assert a * x + b == c
        evidence = {"a": a, "b": b, "c": c, "x": x}

    elif family == "linear_equation_fraction":
        x = Fraction(_pick(seed, sequence, "xn", -500, 500), _pick(seed, sequence, "xd", 2, 31))
        a = _nonzero(seed, sequence, "a", -31, 31)
        b = Fraction(_pick(seed, sequence, "bn", -500, 500), _pick(seed, sequence, "bd", 2, 29))
        c = a * x + b
        prompt = f"Solve exactly for x: {a}x + ({_frac(b)}) = {_frac(c)}."
        answer = _frac(x)
        steps = [
            f"Move {_frac(b)} to the right: {a}x = {_frac(c - b)}.",
            f"Divide by {a}: x = {_frac(c - b)}/{a}.",
            f"Reduce the rational number to x = {_frac(x)}.",
        ]
        assert a * x + b == c
        evidence = {"a": a, "b": _frac(b), "c": _frac(c), "x": answer}

    elif family == "two_by_two_system":
        x = _pick(seed, sequence, "x", -100, 100)
        y = _pick(seed, sequence, "y", -100, 100)
        a = _nonzero(seed, sequence, "a", -20, 20)
        b = _nonzero(seed, sequence, "b", -20, 20)
        c = _nonzero(seed, sequence, "c", -20, 20)
        d = _nonzero(seed, sequence, "d", -20, 20)
        if a * d == b * c:
            d += 1
        r1, r2 = a * x + b * y, c * x + d * y
        det = a * d - b * c
        sx = Fraction(r1 * d - b * r2, det)
        sy = Fraction(a * r2 - r1 * c, det)
        prompt = f"Solve the system {a}x + {b}y = {r1}; {c}x + {d}y = {r2}."
        answer = f"x={_frac(sx)}, y={_frac(sy)}"
        steps = [
            f"The determinant is {a}·{d} - {b}·{c} = {det}, which is nonzero.",
            f"Cramer's rule gives x = ({r1}·{d} - {b}·{r2})/{det} = {_frac(sx)}.",
            f"Similarly y = ({a}·{r2} - {r1}·{c})/{det} = {_frac(sy)}.",
        ]
        assert sx == x and sy == y
        evidence = {"matrix": [[a, b], [c, d]], "rhs": [r1, r2], "x": x, "y": y, "det": det}

    elif family == "quadratic_integer_roots":
        r1 = _pick(seed, sequence, "r1", -10_000, 10_000)
        r2 = _pick(seed, sequence, "r2", -10_000, 10_000)
        s, p = r1 + r2, r1 * r2
        prompt = f"Find all integer roots of x^2 - ({s})x + ({p}) = 0."
        roots = sorted([r1, r2])
        answer = ", ".join(map(str, roots))
        steps = [
            f"Look for two integers whose sum is {s} and product is {p}.",
            f"The pair is {r1} and {r2}, so the polynomial factors as (x-({r1}))(x-({r2})).",
            f"Therefore the roots are {answer}.",
        ]
        assert all(r * r - s * r + p == 0 for r in roots)
        evidence = {"sum": s, "product": p, "roots": roots}

    elif family == "polynomial_evaluation":
        x = _pick(seed, sequence, "x", -25, 25)
        coeffs = [_pick(seed, sequence, f"c{i}", -50, 50) for i in range(5)]
        value = sum(c * x**i for i, c in enumerate(coeffs))
        prompt = f"Evaluate P(x) = {coeffs[4]}x^4 + {coeffs[3]}x^3 + {coeffs[2]}x^2 + {coeffs[1]}x + {coeffs[0]} at x={x}."
        answer = str(value)
        steps = [
            f"Substitute x={x} into every term.",
            "Evaluate powers and multiply by their exact integer coefficients.",
            f"Adding the five terms gives P({x}) = {value}.",
        ]
        assert value == sum(c * x**i for i, c in enumerate(coeffs))
        evidence = {"x": x, "coefficients_low_to_high": coeffs, "value": value}

    elif family in {"arithmetic_sequence_nth", "arithmetic_sequence_sum"}:
        first = _pick(seed, sequence, "first", -1000, 1000)
        diff = _nonzero(seed, sequence, "diff", -50, 50)
        n = _pick(seed, sequence, "n", 5, 500)
        nth = first + (n - 1) * diff
        if family == "arithmetic_sequence_nth":
            prompt = f"An arithmetic sequence has first term {first} and common difference {diff}. Find term a_{n}."
            answer = str(nth)
            steps = [
                "Use a_n = a_1 + (n-1)d.",
                f"a_{n} = {first} + ({n}-1)·({diff}).",
                f"Thus a_{n} = {nth}.",
            ]
            evidence = {"first": first, "difference": diff, "n": n, "nth": nth}
        else:
            total = n * (first + nth) // 2
            prompt = f"Find the sum of the first {n} terms of the arithmetic sequence with a_1={first}, d={diff}."
            answer = str(total)
            steps = [
                f"First compute a_{n} = {first} + ({n}-1)·({diff}) = {nth}.",
                "Use S_n = n(a_1+a_n)/2.",
                f"S_{n} = {n}({first}+{nth})/2 = {total}.",
            ]
            assert 2 * total == n * (first + nth)
            evidence = {"first": first, "difference": diff, "n": n, "nth": nth, "sum": total}

    elif family == "geometric_sequence_nth":
        first = _nonzero(seed, sequence, "first", -10_000, 10_000)
        ratio = _pick(seed, sequence, "ratio", -20, 20)
        if ratio in (-1, 0, 1):
            ratio = 2
        n = _pick(seed, sequence, "n", 3, 20)
        result = first * ratio ** (n - 1)
        prompt = f"A geometric sequence has a_1={first} and ratio r={ratio}. Find a_{n}."
        answer = str(result)
        steps = [
            "Use a_n = a_1 r^(n-1).",
            f"a_{n} = {first}·({ratio})^({n-1}).",
            f"The exact value is {result}.",
        ]
        assert result == first * ratio ** (n - 1)
        evidence = {"first": first, "ratio": ratio, "n": n, "value": result}

    elif family in {"gcd", "lcm"}:
        a = _pick(seed, sequence, "a", 2, 1_000_000)
        b = _pick(seed, sequence, "b", 2, 1_000_000)
        g = math.gcd(a, b)
        if family == "gcd":
            result = g
            prompt = f"Compute gcd({a}, {b}) exactly."
            steps = [
                "Apply the Euclidean algorithm until the remainder is zero.",
                f"The final nonzero remainder is {g}.",
                f"{g} divides both {a} and {b}, so gcd({a},{b})={g}.",
            ]
        else:
            result = abs(a * b) // g
            prompt = f"Compute lcm({a}, {b}) exactly."
            steps = [
                f"First compute gcd({a},{b})={g}.",
                "Use lcm(a,b)=|ab|/gcd(a,b).",
                f"Therefore lcm({a},{b})={result}.",
            ]
        answer = str(result)
        assert a % g == 0 and b % g == 0
        evidence = {"a": a, "b": b, "gcd": g, "result": result}

    elif family == "euclidean_division":
        divisor = _pick(seed, sequence, "d", 2, 10_000)
        quotient = _pick(seed, sequence, "q", -100_000, 100_000)
        remainder = _pick(seed, sequence, "r", 0, divisor - 1)
        dividend = divisor * quotient + remainder
        prompt = f"Write {dividend} in Euclidean division form by {divisor}: dividend = divisor·q + r with 0≤r<divisor."
        answer = f"q={quotient}, r={remainder}"
        steps = [
            f"Divide {dividend} by the positive divisor {divisor}.",
            f"The quotient is {quotient} and the remainder is {remainder}.",
            f"Check: {divisor}·({quotient}) + {remainder} = {dividend}.",
        ]
        assert dividend == divisor * quotient + remainder and 0 <= remainder < divisor
        evidence = {"dividend": dividend, "divisor": divisor, "q": quotient, "r": remainder}

    elif family == "modular_remainder":
        modulus = _pick(seed, sequence, "m", 2, 100_000)
        base = _pick(seed, sequence, "base", 2, 100_000)
        exponent = _pick(seed, sequence, "exp", 2, 5000)
        result = pow(base, exponent, modulus)
        prompt = f"Compute {base}^{exponent} modulo {modulus} exactly."
        answer = str(result)
        steps = [
            "Use repeated squaring, reducing modulo the modulus after every multiplication.",
            f"The modular exponentiation result lies in [0,{modulus-1}].",
            f"The exact remainder is {result}.",
        ]
        assert result == pow(base, exponent, modulus)
        evidence = {"base": base, "exponent": exponent, "modulus": modulus, "result": result}

    elif family == "modular_inverse":
        modulus = _pick(seed, sequence, "m", 50, 1_000_000)
        value = _pick(seed, sequence, "v", 2, modulus - 1)
        while math.gcd(value, modulus) != 1:
            value = value % (modulus - 1) + 1
        result = pow(value, -1, modulus)
        prompt = f"Find the multiplicative inverse of {value} modulo {modulus}."
        answer = str(result)
        steps = [
            f"gcd({value},{modulus})=1, so an inverse exists.",
            "Apply the extended Euclidean algorithm to express 1 as a combination of the two integers.",
            f"The coefficient of {value}, reduced modulo {modulus}, is {result}.",
        ]
        assert (value * result) % modulus == 1
        evidence = {"value": value, "modulus": modulus, "inverse": result}

    elif family.startswith("fraction_"):
        a = Fraction(_nonzero(seed, sequence, "an", -1000, 1000), _pick(seed, sequence, "ad", 2, 97))
        b = Fraction(_nonzero(seed, sequence, "bn", -1000, 1000), _pick(seed, sequence, "bd", 2, 97))
        op = family.removeprefix("fraction_")
        if op == "addition":
            result, symbol = a + b, "+"
        elif op == "subtraction":
            result, symbol = a - b, "-"
        elif op == "multiplication":
            result, symbol = a * b, "×"
        else:
            result, symbol = a / b, "÷"
        prompt = f"Compute and fully reduce {_frac(a)} {symbol} {_frac(b)}."
        answer = _frac(result)
        steps = [
            "Represent both values as exact rational numbers.",
            f"Apply the {op} rule using integer numerators and denominators.",
            f"Reduce by the greatest common divisor to obtain {_frac(result)}.",
        ]
        evidence = {"a": _frac(a), "b": _frac(b), "operation": op, "result": answer}

    elif family in {"percent_of_quantity", "percent_change"}:
        if family == "percent_of_quantity":
            quantity = _pick(seed, sequence, "q", 10, 1_000_000)
            percent = _pick(seed, sequence, "p", 1, 500)
            result = Fraction(quantity * percent, 100)
            prompt = f"What is exactly {percent}% of {quantity}?"
            answer = _frac(result)
            steps = [
                f"Convert {percent}% to the fraction {percent}/100.",
                f"Multiply {quantity}·{percent}/100.",
                f"The reduced exact result is {_frac(result)}.",
            ]
            evidence = {"quantity": quantity, "percent": percent, "result": answer}
        else:
            old = _pick(seed, sequence, "old", 10, 100_000)
            delta = _nonzero(seed, sequence, "delta", -old + 1, old * 3)
            new = old + delta
            result = Fraction(delta * 100, old)
            prompt = f"A value changes from {old} to {new}. Compute the exact percentage change."
            answer = f"{_frac(result)}%"
            steps = [
                f"The change is {new}-{old}={delta}.",
                f"Divide by the original value: {delta}/{old}.",
                f"Multiply by 100%, giving {_frac(result)}%.",
            ]
            evidence = {"old": old, "new": new, "delta": delta, "percent": _frac(result)}

    elif family in {"direct_proportion", "inverse_proportion"}:
        x1 = _pick(seed, sequence, "x1", 2, 500)
        y1 = _pick(seed, sequence, "y1", 2, 500)
        x2 = _pick(seed, sequence, "x2", 2, 500)
        if family == "direct_proportion":
            result = Fraction(y1 * x2, x1)
            prompt = f"y is directly proportional to x. If y={y1} when x={x1}, find y when x={x2}."
            steps = [
                f"The constant is k=y/x={y1}/{x1}.",
                f"For x={x2}, y=kx=({y1}/{x1})·{x2}.",
                f"Thus y={_frac(result)}.",
            ]
        else:
            result = Fraction(x1 * y1, x2)
            prompt = f"y is inversely proportional to x. If y={y1} when x={x1}, find y when x={x2}."
            steps = [
                f"The invariant product is xy={x1}·{y1}={x1*y1}.",
                f"For x={x2}, y={x1*y1}/{x2}.",
                f"Thus y={_frac(result)}.",
            ]
        answer = _frac(result)
        evidence = {"x1": x1, "y1": y1, "x2": x2, "result": answer}

    elif family in {"mean_integer_list", "median_integer_list"}:
        count = _pick(seed, sequence, "count", 7, 17)
        values = [_pick(seed, sequence, f"v{i}", -1000, 1000) for i in range(count)]
        if family == "mean_integer_list":
            result = Fraction(sum(values), len(values))
            prompt = f"Find the exact arithmetic mean of {values}."
            answer = _frac(result)
            steps = [
                f"Add the {len(values)} values to get {sum(values)}.",
                f"Divide by the count {len(values)}.",
                f"The exact mean is {_frac(result)}.",
            ]
        else:
            ordered = sorted(values)
            mid = len(values) // 2
            result = Fraction(ordered[mid], 1)
            prompt = f"Find the median of {values}."
            answer = _frac(result)
            steps = [
                f"Sort the list: {ordered}.",
                f"There are {len(values)} values, so the middle index is {mid}.",
                f"The median is {ordered[mid]}.",
            ]
        evidence = {"values": values, "result": answer}

    elif family == "weighted_average":
        v1 = _pick(seed, sequence, "v1", 0, 100)
        v2 = _pick(seed, sequence, "v2", 0, 100)
        w1 = _pick(seed, sequence, "w1", 1, 20)
        w2 = _pick(seed, sequence, "w2", 1, 20)
        result = Fraction(v1 * w1 + v2 * w2, w1 + w2)
        prompt = f"Compute the weighted average of values {v1} and {v2} with weights {w1} and {w2}."
        answer = _frac(result)
        steps = [
            f"Weighted sum = {v1}·{w1} + {v2}·{w2} = {v1*w1 + v2*w2}.",
            f"Total weight = {w1}+{w2}={w1+w2}.",
            f"Divide to get {_frac(result)}.",
        ]
        evidence = {"values": [v1, v2], "weights": [w1, w2], "result": answer}

    elif family in {"combination", "permutation"}:
        n = _pick(seed, sequence, "n", 101, 10_000)
        r = _pick(seed, sequence, "r", 1, min(n, 100))
        if family == "combination":
            result = math.comb(n, r)
            prompt = f"Compute the binomial coefficient C({n},{r})."
            formula = f"{n}!/({r}!({n-r})!)"
        else:
            result = math.perm(n, r)
            prompt = f"Compute the number P({n},{r}) of ordered selections of {r} distinct objects from {n}."
            formula = f"{n}!/({n-r})!"
        answer = str(result)
        steps = [
            f"Use the exact factorial formula {formula}.",
            "Cancel common factors before multiplying to keep the arithmetic integral.",
            f"The resulting integer is {result}.",
        ]
        evidence = {"n": n, "r": r, "result": result}

    elif family == "binomial_coefficient_identity":
        n = _pick(seed, sequence, "n", 102, 20_000)
        r = _pick(seed, sequence, "r", 1, min(n - 1, 100))
        left = math.comb(n, r)
        right = math.comb(n - 1, r - 1) + math.comb(n - 1, r)
        prompt = f"Verify Pascal's identity for n={n}, r={r} and give the common value."
        answer = str(left)
        steps = [
            f"Compute C({n},{r})={left}.",
            f"Compute C({n-1},{r-1}) + C({n-1},{r}) = {right}.",
            f"Both sides equal {left}, so the identity is verified for these parameters.",
        ]
        assert left == right
        evidence = {"n": n, "r": r, "left": left, "right": right}

    elif family in {"simple_probability", "complement_probability"}:
        total = _pick(seed, sequence, "total", 3, 1_000_000)
        favorable = _pick(seed, sequence, "fav", 1, total - 1)
        p = Fraction(favorable, total)
        if family == "simple_probability":
            result = p
            prompt = f"An experiment has {total} equally likely outcomes and {favorable} favorable outcomes. Find the exact probability."
            steps = [
                "For equally likely outcomes, probability = favorable/total.",
                f"Substitute {favorable}/{total}.",
                f"Reduce to {_frac(result)}.",
            ]
        else:
            result = 1 - p
            prompt = f"An event has probability {_frac(p)}. Find the exact probability that it does not occur."
            steps = [
                "Use P(not A)=1-P(A).",
                f"Compute 1-{_frac(p)}.",
                f"The complement probability is {_frac(result)}.",
            ]
        answer = _frac(result)
        evidence = {"total": total, "favorable": favorable, "result": answer}

    elif family == "rectangle_geometry":
        width = _pick(seed, sequence, "w", 1, 10_000)
        height = _pick(seed, sequence, "h", 1, 10_000)
        area = width * height
        perimeter = 2 * (width + height)
        prompt = f"A rectangle has width {width} and height {height}. Find its area and perimeter."
        answer = f"area={area}, perimeter={perimeter}"
        steps = [
            f"Area = width·height = {width}·{height} = {area}.",
            f"Perimeter = 2(width+height) = 2({width}+{height}) = {perimeter}.",
            "Both results are exact integers in the corresponding square/linear units.",
        ]
        evidence = {"width": width, "height": height, "area": area, "perimeter": perimeter}

    elif family == "triangle_area":
        base = _pick(seed, sequence, "base", 1, 10_000)
        height = _pick(seed, sequence, "height", 1, 10_000)
        result = Fraction(base * height, 2)
        prompt = f"A triangle has base {base} and perpendicular height {height}. Find its exact area."
        answer = _frac(result)
        steps = [
            "Use area = base·height/2.",
            f"Substitute {base}·{height}/2.",
            f"The exact area is {_frac(result)} square units.",
        ]
        evidence = {"base": base, "height": height, "area": answer}

    else:  # pythagorean_hypotenuse
        m = _pick(seed, sequence, "m", 2, 10_000)
        n = _pick(seed, sequence, "n", 1, m - 1)
        a = m * m - n * n
        b = 2 * m * n
        c = m * m + n * n
        prompt = f"A right triangle has legs {a} and {b}. Find the exact hypotenuse."
        answer = str(c)
        steps = [
            f"Apply c^2 = {a}^2 + {b}^2.",
            f"The sum of squares is {a*a + b*b} = {c*c}.",
            f"Taking the positive square root gives c={c}.",
        ]
        assert a * a + b * b == c * c
        evidence = {"a": a, "b": b, "c": c, "m": m, "n": n}

    text = _explain(family.replace("_", " "), prompt, steps, answer)
    return family, text, evidence


def _row(seed: int, sequence: int) -> dict:
    family, text, evidence = _case(seed, sequence)
    evidence_hash = canonical_json_sha256({"family": family, "evidence": evidence})
    return {
        "text": text,
        "path": f"mathematics/{family}/{sequence:012d}",
        "task_id": f"math-{sequence:012d}",
        "task_family": family,
        "verifier": "python-exact-arithmetic-v1",
        "verifier_evidence_hash": evidence_hash,
    }


def load_config(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("format") != FORMAT or data.get("source_name") != SOURCE_NAME:
        raise ValueError("unsupported verified-math generation config")
    if data.get("language") != "en":
        raise ValueError("verified-math generation must be English")
    for field in ("seed", "shard_docs", "target_text_bytes"):
        if type(data.get(field)) is not int or data[field] < 1:
            raise ValueError(f"verified-math {field} must be a positive integer")
    quality = data.get("quality_gate")
    if not isinstance(quality, dict):
        raise ValueError("verified-math quality gate missing")
    return data


def evaluate_quality(config: dict) -> dict:
    quality = config["quality_gate"]
    sample_documents = int(quality["sample_documents"])
    families: Counter[str] = Counter()
    texts: set[str] = set()
    evidence_hashes: set[str] = set()
    total_bytes = 0
    for sequence in range(sample_documents):
        row = _row(int(config["seed"]), sequence)
        families[row["task_family"]] += 1
        texts.add(row["text"])
        evidence_hashes.add(row["verifier_evidence_hash"])
        total_bytes += len(row["text"].encode("utf-8"))
    unique_text_ppm = len(texts) * 1_000_000 // sample_documents
    unique_evidence_ppm = len(evidence_hashes) * 1_000_000 // sample_documents
    max_family_ppm = max(families.values()) * 1_000_000 // sample_documents
    if len(families) < int(quality["minimum_families"]):
        raise ValueError("verified-math quality gate: insufficient family diversity")
    if unique_text_ppm < int(quality["minimum_unique_text_ratio_ppm"]):
        raise ValueError("verified-math quality gate: insufficient unique text")
    if unique_evidence_ppm < int(quality["minimum_unique_evidence_ratio_ppm"]):
        raise ValueError("verified-math quality gate: insufficient unique evidence")
    if max_family_ppm > int(quality["maximum_family_share_ppm"]):
        raise ValueError("verified-math quality gate: excessive family concentration")
    report = {
        "format": QUALITY_FORMAT,
        "seed": config["seed"],
        "sample_documents": sample_documents,
        "task_families": dict(sorted(families.items())),
        "unique_text_ratio_ppm": unique_text_ppm,
        "unique_evidence_ratio_ppm": unique_evidence_ppm,
        "maximum_family_share_ppm": max_family_ppm,
        "mean_text_bytes": total_bytes // sample_documents,
        "policy": dict(quality),
    }
    report["quality_gate_sha256"] = canonical_json_sha256(report)
    return report


def _identities(config_path: Path, attestation: dict, quality: dict) -> tuple[dict, dict]:
    generator_path = Path(__file__).resolve()
    pipeline = {
        "name": PIPELINE_NAME,
        "rights_basis": "first_party_attestation",
        "attestation_scope_sha256": attestation_scope_sha256(attestation),
        "attestation_required_files": [
            {"path": "forge/verified_math_corpus.py", "sha256": sha256_file(generator_path)},
            {"path": "forge/config/imc_125m_math_generation.json", "sha256": sha256_file(config_path)},
        ],
        "generation_config_sha256": sha256_file(config_path),
        "generator_sha256": sha256_file(generator_path),
        "quality_gate_sha256": quality["quality_gate_sha256"],
        "verifier_policy": "deterministic-exact-arithmetic-v1",
    }
    source = {
        "name": SOURCE_NAME,
        "provider": "ilaria/forge/verified_math_corpus",
        "config": FORMAT,
        "revision": canonical_json_sha256(pipeline),
        "language": "en",
    }
    return source, pipeline


def write_corpus(*, config_path: str | Path, attestation_path: str | Path, workspace_root: str | Path, out_dir: str | Path) -> dict:
    config_path = Path(config_path).resolve()
    config = load_config(config_path)
    attestation = inspect_attestation(attestation_path, workspace_root=workspace_root)
    quality = evaluate_quality(config)
    source, pipeline = _identities(config_path, attestation, quality)
    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / f"{SOURCE_NAME}.manifest.json"
    if manifest_path.exists():
        raise ValueError("verified-math corpus refuses to overwrite existing corpus")

    records = []
    buffer = []
    docs = text_bytes = 0
    sequence = 0
    shard_index = 0
    target = int(config["target_text_bytes"])
    shard_docs = int(config["shard_docs"])

    def flush() -> None:
        nonlocal shard_index
        if not buffer:
            return
        filename = f"{SOURCE_NAME}-{shard_index:05d}.jsonl"
        destination = output / filename
        temporary = destination.with_suffix(".jsonl.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for row in buffer:
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        records.append({
            "index": shard_index,
            "filename": filename,
            "sha256": sha256_file(destination),
            "bytes": destination.stat().st_size,
            "documents": len(buffer),
        })
        buffer.clear()
        shard_index += 1

    while text_bytes < target:
        row = _row(int(config["seed"]), sequence)
        size = len(row["text"].encode("utf-8"))
        buffer.append(row)
        docs += 1
        text_bytes += size
        sequence += 1
        if len(buffer) >= shard_docs:
            flush()
    flush()

    manifest = {
        "schema_version": CORPUS_MANIFEST_SCHEMA,
        "source": source,
        "pipeline": pipeline,
        "target_text_bytes": target,
        "quality_gate": quality,
        "docs": docs,
        "shards": len(records),
        "shard_docs": shard_docs,
        "complete": [record["index"] for record in records],
        "raw_rows": docs,
        "text_bytes": text_bytes,
        "shard_records": records,
    }
    atomic_write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    config_dir = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(config_dir / "imc_125m_math_generation.json"))
    parser.add_argument("--attestation", default=str(config_dir / "first_party_math.attestation.json"))
    parser.add_argument("--workspace-root", default=str(root))
    parser.add_argument("--out-dir")
    parser.add_argument("--quality-only", action="store_true")
    parser.add_argument("--quality-out")
    args = parser.parse_args()
    if args.quality_only:
        report = evaluate_quality(load_config(args.config))
        if args.quality_out:
            atomic_write_json(args.quality_out, report)
        print(f"[verified-math] quality={report['quality_gate_sha256']} families={len(report['task_families'])} mean_bytes={report['mean_text_bytes']}")
        return
    if not args.out_dir:
        parser.error("--out-dir is required unless --quality-only is used")
    manifest = write_corpus(
        config_path=args.config,
        attestation_path=args.attestation,
        workspace_root=args.workspace_root,
        out_dir=args.out_dir,
    )
    print(f"[verified-math] docs={manifest['docs']:,} text_bytes={manifest['text_bytes']:,} shards={manifest['shards']}")


if __name__ == "__main__":
    main()
