/**
 * Username: validare, disponibilitate, alias la redenumire și rezolvarea
 * rutei /u/<x> (username curent, alias vechi sau UUID → username canonic).
 */
import { dbQuery, type TxQuery } from "@/lib/db";
import { UUID_RE } from "@/lib/validation/uuid";
import { USERNAME_RULES, reservedUsernames } from "./config";

export type UsernameProblem = "username_invalid" | "username_reserved" | "username_taken";

export function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^@+/, "").toLowerCase();
}

/** Verificări fără DB (format + nume rezervate). */
export function checkUsernameFormat(username: string): UsernameProblem | null {
  if (username.length < USERNAME_RULES.min || username.length > USERNAME_RULES.max) return "username_invalid";
  if (!USERNAME_RULES.pattern.test(username)) return "username_invalid";
  if (reservedUsernames().has(username)) return "username_reserved";
  return null;
}

/**
 * Liber = niciun alt cont nu îl are ca username curent sau ca alias vechi.
 * Propriul alias vechi poate fi reluat.
 */
export async function checkUsernameAvailable(username: string, userId: string | null): Promise<UsernameProblem | null> {
  const format = checkUsernameFormat(username);
  if (format) return format;
  const { rows } = await dbQuery<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE lower(username) = $1 AND ($2::uuid IS NULL OR id <> $2::uuid))
         OR EXISTS (SELECT 1 FROM username_aliases WHERE username_lower = $1 AND ($2::uuid IS NULL OR user_id <> $2::uuid))
         AS taken`,
    [username, userId],
  );
  return rows[0]?.taken ? "username_taken" : null;
}

/** În tranzacția redenumirii: numele vechi devine alias al aceluiași cont. */
export async function recordUsernameAlias(q: TxQuery, userId: string, oldUsername: string, newUsername: string): Promise<void> {
  const oldLower = oldUsername.toLowerCase();
  if (!oldLower || oldLower === newUsername.toLowerCase()) return;
  await q(
    `INSERT INTO username_aliases (username_lower, user_id) VALUES ($1, $2)
     ON CONFLICT (username_lower) DO NOTHING`,
    [oldLower, userId],
  );
  // Numele nou nu mai e alias (dacă userul își reia un nume vechi).
  await q(`DELETE FROM username_aliases WHERE username_lower = $1 AND user_id = $2`, [newUsername.toLowerCase(), userId]);
}

export type ProfileRouteResolution =
  | { kind: "canonical"; username: string }
  | { kind: "redirect"; username: string }
  | { kind: "not_found" };

/** /u/<param>: username curent → randare; UUID sau alias vechi → redirect la username. */
export async function resolveProfileParam(param: string): Promise<ProfileRouteResolution> {
  let raw = param.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // parametru deja decodat sau malformat — îl folosim ca atare
  }
  if (UUID_RE.test(raw)) {
    const { rows } = await dbQuery<{ username: string }>(
      `SELECT username FROM users WHERE id = $1 AND status = 'active'`,
      [raw],
    );
    return rows[0] ? { kind: "redirect", username: rows[0].username } : { kind: "not_found" };
  }
  const username = normalizeUsername(raw);
  if (!username || username.length > 64) return { kind: "not_found" };
  const { rows } = await dbQuery<{ username: string; via_alias: boolean }>(
    `SELECT username, via_alias FROM (
       SELECT u.username, false AS via_alias FROM users u WHERE lower(u.username) = $1 AND u.status = 'active'
       UNION ALL
       SELECT u.username, true FROM username_aliases a JOIN users u ON u.id = a.user_id
        WHERE a.username_lower = $1 AND u.status = 'active'
     ) m
     ORDER BY via_alias
     LIMIT 1`,
    [username],
  );
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (row.via_alias || row.username !== raw.replace(/^@+/, "")) return { kind: "redirect", username: row.username };
  return { kind: "canonical", username: row.username };
}
