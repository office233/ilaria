/**
 * Explorare pentru clipurile noi: bandit Thompson pe rata de completare.
 * Fiecare clip nou are posterior Beta(completări + 1, impresii − completări + 1);
 * la fiecare slot de explorare se eșantionează posteriorul tuturor clipurilor
 * rămase și câștigă eșantionul maxim. Clipurile fără date primesc Beta(1,1)
 * (uniform) → primesc impresii garantate până devin „vechi” (vârstă/impresii).
 *
 * RNG-ul e injectat (seeded, determinist) — pagina N se poate recalcula
 * identic din cursor chiar fără Redis.
 */
export type Rng = () => number;

/** mulberry32 — PRNG mic, determinist, suficient pentru ranking. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) — Marsaglia & Tsang. */
export function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(Math.max(alpha, 1e-3), rng);
  const y = sampleGamma(Math.max(beta, 1e-3), rng);
  return x + y === 0 ? 0.5 : x / (x + y);
}

export type BanditArm = { id: string; successes: number; trials: number };

/** Indexul brațului câștigător (eșantion Thompson maxim), sau -1 pentru listă goală. */
export function thompsonPick(arms: readonly BanditArm[], rng: Rng): number {
  let best = -1;
  let bestSample = -Infinity;
  arms.forEach((arm, i) => {
    const s = Math.max(0, Math.min(arm.successes, arm.trials));
    const f = Math.max(0, arm.trials - s);
    const sample = sampleBeta(s + 1, f + 1, rng);
    if (sample > bestSample) {
      bestSample = sample;
      best = i;
    }
  });
  return best;
}
