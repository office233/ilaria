/**
 * CUI / CIF românesc: 2–10 cifre, ultima e cifra de control (cheia 753217532).
 * Prefixul „RO” marchează o firmă înregistrată în scopuri de TVA.
 */
const CONTROL_KEY = "753217532";

export type ParsedCui = { digits: string; vatRegistered: boolean };

export function parseCui(value: string | null | undefined): ParsedCui | null {
  const compact = (value ?? "").replace(/\s+/g, "").toUpperCase();
  const m = /^(RO)?(\d{2,10})$/.exec(compact);
  if (!m) return null;
  return { digits: m[2], vatRegistered: m[1] === "RO" };
}

export function isValidCuiDigits(digits: string): boolean {
  if (!/^\d{2,10}$/.test(digits)) return false;
  const body = digits.slice(0, -1).padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * Number(CONTROL_KEY[i]);
  const control = ((sum * 10) % 11) % 10;
  return control === Number(digits[digits.length - 1]);
}

/** CUI valid (cu sau fără „RO”), altfel null. */
export function validCui(value: string | null | undefined): ParsedCui | null {
  const parsed = parseCui(value);
  return parsed && isValidCuiDigits(parsed.digits) ? parsed : null;
}
