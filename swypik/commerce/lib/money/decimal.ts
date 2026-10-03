/**
 * Parsează o sumă zecimală în minor units fără aritmetică floating-point.
 * Pentru scale=2: "10.05" -> 1005. Mai mult de 2 zecimale este invalid,
 * nu rotunjit implicit.
 */
export function decimalToMinorUnits(
  value: string | number,
  scale = 2,
): number | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;

  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const fraction = match[2] ?? "";
  if (fraction.length > scale) return null;

  const factor = 10n ** BigInt(scale);
  const whole = BigInt(match[1]);
  const fractional =
    scale === 0
      ? 0n
      : BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  const units = whole * factor + fractional;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

export function decimalToCents(value: string | number): number | null {
  return decimalToMinorUnits(value, 2);
}
