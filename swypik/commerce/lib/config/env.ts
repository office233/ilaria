/**
 * Citire tipizată a parametrilor numerici din env, cu fallback explicit și
 * interval permis. Folosită de modulele de configurare (Movies, Music)
 * ca nicio valoare să nu fie hardcodată în rute sau componente.
 */
export function intEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
}
