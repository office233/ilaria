import { dbQuery } from "@/lib/db";

/** Username-ul curent, curățat pentru regula handle-ului (a-z0-9_. , 3–32); "" dacă nu se potrivește. */
export async function loadSuggestedHandle(userId: string): Promise<string> {
  const { rows } = await dbQuery<{ username: string | null }>(`SELECT username FROM users WHERE id = $1`, [userId]);
  const clean = (rows[0]?.username ?? "").toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 32);
  return clean.length >= 3 ? clean : "";
}
