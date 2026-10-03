/**
 * Verificarea mediului la pornirea unei replici de producție (fail fast).
 *
 * Cu N replici identice, toate TREBUIE să aibă aceleași secrete: sesiunile și
 * tokenurile semnate/criptate pe replica A sunt verificate pe replica B
 * (APP_ENCRYPTION_KEY: 2FA, CNP, secret-box, tokenuri de stream; CRON_SECRET:
 * cron-worker → orice replică). Un secret lipsă nu trebuie să fie descoperit
 * abia la prima cerere care îl folosește (sau, mai rău, înlocuit în tăcere de
 * un fallback per-proces) — replica refuză să pornească, cu un log clar.
 *
 * Scăpare pentru `next start` local cu NODE_ENV=production: SKIP_ENV_CHECK=1.
 */

export type EnvRule = { name: string; test?: (value: string) => boolean; hint: string };

export const REQUIRED_PRODUCTION_ENV: readonly EnvRule[] = [
  { name: "DATABASE_URL", hint: "Postgres partajat de toate replicile" },
  { name: "REDIS_URL", hint: "Redis partajat: rate limit, pub/sub realtime, cache Next, idempotență" },
  {
    name: "APP_ENCRYPTION_KEY",
    test: (v) => /^[0-9a-f]{64}$/i.test(v),
    hint: "32 bytes hex (64 caractere), IDENTIC pe toate replicile",
  },
  { name: "CRON_SECRET", hint: "identic pe toate replicile și în cron-worker / dispatch-worker" },
];

export function findEnvProblems(env: NodeJS.ProcessEnv, rules: readonly EnvRule[] = REQUIRED_PRODUCTION_ENV): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const value = (env[rule.name] || "").trim();
    if (!value) problems.push(`${rule.name} lipsește (${rule.hint})`);
    else if (rule.test && !rule.test(value)) problems.push(`${rule.name} invalid (${rule.hint})`);
  }
  return problems;
}

export function shouldCheckEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" && env.SKIP_ENV_CHECK !== "1" && env.NEXT_PHASE !== "phase-production-build";
}

/**
 * Oprește procesul dacă lipsesc secrete obligatorii. `exit` e injectabil pentru teste.
 * Scrie direct pe stderr: logger-ul poate depinde chiar de configul care lipsește.
 */
export function assertProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): string[] {
  if (!shouldCheckEnv(env)) return [];
  const problems = findEnvProblems(env);
  if (problems.length > 0) {
    console.error(
      `[boot] FATAL: configurație de producție incompletă — replica nu pornește:\n  - ${problems.join("\n  - ")}\n` +
        "  (setează variabilele în .env.production; SKIP_ENV_CHECK=1 doar pentru teste locale)",
    );
    exit(1);
  }
  return problems;
}
