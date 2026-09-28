/**
 * Linkul public de urmărire a cursei (/go/track/[token]) — cât rămâne valid
 * după finalul cursei. Audit food-go #9: înainte 1h cu poziția șoferului vizibilă.
 * Env GO_SHARE_TTL_AFTER_END_MIN (1–1440, implicit 15).
 */
export function shareTtlAfterEndMinutes(raw = process.env.GO_SHARE_TTL_AFTER_END_MIN): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? Math.trunc(n) : 15;
}

/** Expresia SQL pentru `share_expires_at` la finalul cursei. */
export function shareExpirySql(): string {
  return `now() + make_interval(mins => ${shareTtlAfterEndMinutes()})`;
}
