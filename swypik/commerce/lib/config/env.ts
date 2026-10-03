/**
 * Citire tipizată a parametrilor numerici din env, cu fallback explicit și
 * interval permis. Modulele de configurare folosesc utilitarul comun ca să nu
 * existe parsere locale cu comportamente diferite.
 */
export function intEnv(
  name: string,
  fallback: number,
  min: number = Number.MIN_SAFE_INTEGER,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
