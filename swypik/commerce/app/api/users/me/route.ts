/**
 * PATCH /api/users/me — update the current user's profile.
 *
 * Auth-gated via the canonical session resolver (`getAuthSession`).
 * Accepts a JSON body with any subset of `display_name`, `bio`, `username`.
 * Validates lengths/format, enforces username uniqueness, and rate-limits to
 * 5 updates per 10 minutes per user.
 */

import { NextResponse } from "next/server";
import { moderateUserText } from "@/lib/moderation/ai-text";
import { recordStrike } from "@/lib/moderation/strikes";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery, withTransaction } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";
import { UserProfilePatchSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { checkUsernameAvailable, normalizeUsername, recordUsernameAlias } from "@/lib/social/username";

export const dynamic = "force-dynamic";

type UserRow = {
  id: string;
  email: string | null;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

export async function PATCH(request: Request) {
  return handlePatch(request);
}

/**
 * GET /api/users/me/social — link-urile publice și categoriile preferate ale
 * utilizatorului curent (folosite de ecranul de setări profil).
 */
export async function GET() {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ rows: cpRows }, { rows: interestRows }] = await Promise.all([
    dbQuery<{ website_url: string | null; social_links: Record<string, string> | null }>(
      `SELECT website_url, social_links FROM creator_profiles WHERE user_id = $1 LIMIT 1`,
      [session.userId]
    ),
    dbQuery<{ topic: string }>(
      `SELECT topic FROM user_interests WHERE user_id = $1 ORDER BY weight DESC, topic ASC LIMIT 8`,
      [session.userId]
    ),
  ]);

  const links: { label: string; url: string }[] = [];
  const website = cpRows[0]?.website_url;
  if (website) links.push({ label: "website", url: website });
  const social = cpRows[0]?.social_links;
  if (social && typeof social === "object") {
    for (const [label, url] of Object.entries(social)) {
      if (typeof url === "string" && url) links.push({ label, url });
    }
  }

  return NextResponse.json({
    links,
    categories: interestRows.map((r) => r.topic),
  });
}

async function handlePatch(request: Request) {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { success } = await rateLimit("profile_edit", session.userId, {
    limit: 5,
    window: 600,
  });
  if (!success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = parseBody(UserProfilePatchSchema, rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  }
  const body = parsed.data;

  const updates: { col: string; val: string | null }[] = [];

  if (body.display_name !== undefined) {
    const v = body.display_name;
    const mDn = await moderateUserText(v, "display_name");
    if (mDn.action !== "allow") {
      void recordStrike({
        userId: session.userId,
        label: mDn.label === "blocked" ? "blocked" : mDn.label === "adult" ? "adult" : "sensitive",
        context: "display_name",
        reason: mDn.message,
        reasons: mDn.reasons,
        signals: mDn.signals as Record<string, unknown>,
      });
      return NextResponse.json({ error: "display_name_rejected", reasons: mDn.reasons }, { status: 422 });
    }
    updates.push({ col: "display_name", val: v });
  }

  if (body.bio !== undefined) {
    const v = body.bio ?? "";
    if (v.length > 0) {
      const m = await moderateUserText(v, "bio");
      if (m.action !== "allow") {
        void recordStrike({
          userId: session.userId,
          label: m.label === "blocked" ? "blocked" : m.label === "adult" ? "adult" : "sensitive",
          context: "bio",
          reason: m.message,
          reasons: m.reasons,
          signals: m.signals as Record<string, unknown>,
        });
        return NextResponse.json({ error: "bio_rejected", reasons: m.reasons }, { status: 422 });
      }
    }
    updates.push({ col: "bio", val: v.length === 0 ? null : v });
  }

  let previousUsername: string | null = null;
  if (body.username !== undefined) {
    const v = normalizeUsername(body.username);
    // Format, nume rezervate, unicitate (inclusiv aliasurile altor conturi).
    const problem = await checkUsernameAvailable(v, session.userId);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: problem === "username_taken" ? 409 : 400 });
    }
    const { rows: cur } = await dbQuery<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [session.userId]);
    previousUsername = cur[0]?.username ?? null;
    if (previousUsername !== v) updates.push({ col: "username", val: v });
  }

  const hasLinks = body.links !== undefined;
  const hasCategories = body.categories !== undefined;

  if (updates.length === 0 && !hasLinks && !hasCategories) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  // Links → creator_profiles.social_links (+website_url dacă există un link "website").
  if (hasLinks) {
    const links = body.links ?? [];
    const socialLinks: Record<string, string> = {};
    let websiteUrl: string | null = null;
    for (const link of links) {
      const key = link.label.trim().toLowerCase();
      if (key === "website" && !websiteUrl) {
        websiteUrl = link.url;
      } else {
        socialLinks[key] = link.url;
      }
    }
    try {
      await dbQuery(
        `INSERT INTO creator_profiles (user_id, handle, social_links, website_url)
         SELECT u.id, u.username, $2::jsonb, $3
           FROM users u WHERE u.id = $1
         ON CONFLICT (user_id) DO UPDATE
           SET social_links = EXCLUDED.social_links,
               website_url = EXCLUDED.website_url,
               updated_at = now()`,
        [session.userId, JSON.stringify(socialLinks), websiteUrl]
      );
    } catch (err) {
      logger.error({ err }, "[users/me PATCH links]");
      return NextResponse.json({ error: "links_save_failed" }, { status: 500 });
    }
  }

  // Categories → user_interests (înlocuiește setul curent, weight descrescător).
  if (hasCategories) {
    const categories = Array.from(new Set(body.categories ?? []));
    try {
      // DELETE + INSERT atomic (audit 2026-08-24): dacă INSERT-ul pica după
      // DELETE, userul rămânea fără niciun interes — personalizarea feed-ului
      // ștearsă ireversibil.
      await withTransaction(async (q) => {
        await q(`DELETE FROM user_interests WHERE user_id = $1`, [session.userId]);
        if (categories.length > 0) {
          const values: string[] = [];
          const params: unknown[] = [session.userId];
          categories.forEach((topic, idx) => {
            params.push(topic, categories.length - idx);
            values.push(`($1, $${params.length - 1}, $${params.length})`);
          });
          await q(
            `INSERT INTO user_interests (user_id, topic, weight) VALUES ${values.join(", ")}
             ON CONFLICT DO NOTHING`,
            params
          );
        }
      });
    } catch (err) {
      logger.error({ err }, "[users/me PATCH categories]");
      return NextResponse.json({ error: "categories_save_failed" }, { status: 500 });
    }
  }

  if (updates.length === 0) {
    const { rows } = await dbQuery<UserRow>(
      `SELECT id, email, username, display_name, bio, avatar_url FROM users WHERE id = $1`,
      [session.userId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ user: rows[0] });
  }

  const setSql = updates.map((u, i) => `${u.col} = $${i + 1}`).join(", ");
  const params: (string | null)[] = updates.map((u) => u.val);
  params.push(session.userId);

  try {
    const rows = await withTransaction(async (q) => {
      const res = await q<UserRow>(
        `UPDATE users
         SET ${setSql}
         WHERE id = $${updates.length + 1}
         RETURNING id, email, username, display_name, bio, avatar_url`,
        params
      );
      const updated = res.rows[0];
      // Linkurile vechi /u/<vechi> redirecționează spre noul username.
      if (updated && previousUsername && previousUsername !== updated.username) {
        await recordUsernameAlias(q, session.userId, previousUsername, updated.username);
      }
      return res.rows;
    });
    if (rows.length === 0) {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    return NextResponse.json({ user: rows[0] });
  } catch (err: unknown) {
    // Unique constraint race condition fallback.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "username_taken" }, { status: 409 });
    }
    logger.error({ err }, "[users/me PATCH]");
    return NextResponse.json({ error: "profile_update_failed" }, { status: 500 });
  }
}
