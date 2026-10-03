/**
 * Cursorul de paginare al feed-ului (opac pentru client, base64url JSON).
 * Fără OFFSET în SQL:
 *   - For You: `s` = id-ul snapshot-ului clasat (Redis), `o` = câte clipuri din
 *     snapshot au fost servite, `seed` = sămânța RNG (fără Redis, clasamentul se
 *     recalculează identic din seed și se continuă de la `o`);
 *   - Following / categorie / profil: keyset (`t` = published_at, `id`).
 *   - `p` = poziția globală (clipuri + carduri) → sloturile modulelor continuă corect.
 * Un cursor invalid = prima pagină (nu eroare).
 */
import { z } from "zod";

const KeysetSchema = z.object({ t: z.string().datetime({ offset: true }), id: z.string().uuid() });

const CursorSchema = z.object({
  v: z.literal(1),
  m: z.enum(["rank", "keyset"]),
  seed: z.number().int().min(0).max(0xffffffff),
  s: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).nullable(),
  o: z.number().int().min(0).max(10_000),
  p: z.number().int().min(0).max(100_000),
  k: KeysetSchema.nullable(),
});

export type FeedCursor = z.infer<typeof CursorSchema>;
export type Keyset = z.infer<typeof KeysetSchema>;

export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (!raw || raw.length > 600) return null;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
