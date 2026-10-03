/**
 * @mențiuni în comentarii. Aceeași expresie e folosită pe client pentru a
 * transforma @username în link (components/social/comments/CommentText.tsx).
 */
import { dbQuery } from "@/lib/db";
import { USERNAME_RULES } from "../config";

/** Un @ la început sau după un caracter care nu e literă/cifră (nu prinde e-mailuri). */
export const MENTION_RE = /(^|[^a-z0-9_.@])@([a-z0-9_]{3,30})/gi;

export function extractMentions(text: string, max: number): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const username = match[2].toLowerCase();
    if (!USERNAME_RULES.pattern.test(username) || out.includes(username)) continue;
    out.push(username);
    if (out.length >= max) break;
  }
  return out;
}

/** Id-urile conturilor active pentru username-urile menționate. */
export async function resolveMentionedUsers(usernames: string[]): Promise<{ id: string; username: string }[]> {
  if (usernames.length === 0) return [];
  const { rows } = await dbQuery<{ id: string; username: string }>(
    `SELECT id, username FROM users
      WHERE lower(username) = ANY($1::text[]) AND status = 'active'`,
    [usernames],
  );
  return rows;
}
