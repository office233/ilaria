import type { PoolClient } from "pg";
import { dbQuery } from "@/lib/db";

/**
 * P2-01: un video pe care nu îl mai poate vedea nimeni (ascuns de moderare,
 * privat, șters sau încă în procesare) nu trebuie să mai primească engagement
 * nou. Fără verificarea asta, oricine deține UUID-ul putea umfla `like_count`
 * / `save_count` pe conținut retras și injecta `feed_events` în semnalele de
 * ranking.
 *
 * SURSA DE ADEVĂR PENTRU SCHEMĂ: `pg_dump --schema-only` din producție, NU
 * `db/schema.sql`. (Fișierul versionat a fost ~4 luni în urmă și m-a făcut să
 * scriu aici, greșit, că `effective_label` nu ar fi coloană pe `videos` — de
 * unde a lipsit filtrul de siguranță în prima versiune a acestui modul.
 * Verificat în prod 2026-08-15: `effective_label | text | NOT NULL |
 * DEFAULT 'safe'`, deci nu e nevoie de COALESCE.)
 *
 * Coloanele filtrate, toate reale pe `videos`:
 *   - status           ∈ uploading|processing|ready|failed|archived|deleted
 *   - visibility       ∈ draft|unlisted|public|private
 *   - is_hidden        boolean — ascundere manuală din moderare
 *   - effective_label  'safe' | 'adult' | 'blocked' — verdictul clasificatorului
 *                      de siguranță; restul codului (feed, search, sitemap,
 *                      profil) cere uniform `= 'safe'`.
 *
 * IMPORTANT: se aplică doar la ADĂUGAREA de engagement. Retragerea (unlike /
 * unsave) rămâne mereu permisă, altfel un utilizator ar rămâne blocat cu un
 * like pe un video care între timp a devenit privat.
 */
const INTERACTABLE_SQL = `SELECT 1 FROM videos
   WHERE id = $1
     AND status = 'ready'
     AND is_hidden = false
     AND visibility IN ('public', 'unlisted')
     AND effective_label = 'safe'`;

/** Varianta pe o conexiune/tranzacție existentă. */
export async function isVideoInteractableTx(
  client: PoolClient,
  videoId: string,
): Promise<boolean> {
  const { rows } = await client.query(INTERACTABLE_SQL, [videoId]);
  return rows.length > 0;
}

/** Varianta pe pool (fără tranzacție deschisă). */
export async function isVideoInteractable(videoId: string): Promise<boolean> {
  const { rows } = await dbQuery(INTERACTABLE_SQL, [videoId]);
  return rows.length > 0;
}
