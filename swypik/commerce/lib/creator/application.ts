/**
 * Aplicarea ca creator — starea curentă + trimiterea formularului.
 */
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

/** Categoriile din formular (cheile de traducere: becomeCreatorForm.categories.<id>). */
export const CREATOR_CATEGORIES = [
  "fashion",
  "beauty",
  "tech",
  "home",
  "food",
  "fitness",
  "gaming",
  "kids",
  "travel",
  "other",
] as const;

export const creatorApplySchema = z
  .object({
    handle: z
      .string()
      .trim()
      .regex(/^[a-z0-9_.]{3,32}$/i),
    category: z.enum(CREATOR_CATEGORIES),
    links: z
      .array(
        z
          .string()
          .trim()
          .url()
          .max(300)
          .refine((u) => /^https:\/\//i.test(u)),
      )
      .max(5)
      .default([]),
    motivation: z.string().trim().max(500).optional().nullable(),
  })
  .strict();
export type CreatorApplyInput = z.infer<typeof creatorApplySchema>;

export type ApplicationView = {
  id: string;
  status: string;
  handle: string;
  category: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type ApplicationState =
  | { state: "creator" | "seller" | "none" }
  | { state: "pending" | "rejected"; application: ApplicationView };

type AppRow = {
  id: string;
  status: string;
  requested_handle: string;
  category: string | null;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
};

function toView(r: AppRow): ApplicationView {
  return {
    id: r.id,
    status: r.status,
    handle: r.requested_handle,
    category: r.category,
    reviewNote: r.review_note,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

export async function getApplicationState(userId: string): Promise<ApplicationState> {
  const { rows: users } = await dbQuery<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  const role = users[0]?.role;
  if (role === "creator" || role === "admin") return { state: "creator" };
  if (role === "seller") return { state: "seller" };

  const { rows } = await dbQuery<AppRow>(
    `SELECT id, status, requested_handle, category, review_note, created_at::text, reviewed_at::text
       FROM creator_applications
      WHERE user_id = $1 AND status IN ('submitted', 'in_review', 'rejected')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  const last = rows[0];
  if (!last) return { state: "none" };
  return { state: last.status === "rejected" ? "rejected" : "pending", application: toView(last) };
}

export type SubmitResult =
  | { ok: true; created: boolean; state: ApplicationState }
  | { ok: false; code: "not_found" | "already_creator" | "seller_cannot_apply" | "handle_taken" };

export async function submitApplication(userId: string, input: CreatorApplyInput): Promise<SubmitResult> {
  const current = await getApplicationState(userId);
  if (current.state === "creator") return { ok: false, code: "already_creator" };
  if (current.state === "seller") return { ok: false, code: "seller_cannot_apply" };
  if (current.state === "pending") return { ok: true, created: false, state: current };

  const { rows: taken } = await dbQuery(
    `SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2 LIMIT 1`,
    [input.handle, userId],
  );
  if (taken[0]) return { ok: false, code: "handle_taken" };

  const socialLinks = Object.fromEntries(input.links.map((u, i) => [`link${i + 1}`, u]));
  try {
    const { rows } = await dbQuery<AppRow>(
      `INSERT INTO creator_applications (user_id, requested_handle, category, website_url, social_links, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       RETURNING id, status, requested_handle, category, review_note, created_at::text, reviewed_at::text`,
      [
        userId,
        input.handle,
        input.category,
        input.links[0] ?? null,
        JSON.stringify(socialLinks),
        JSON.stringify({ motivation: input.motivation ?? null, source: "become_a_creator_form" }),
      ],
    );
    logger.info({ userId, applicationId: rows[0].id }, "creator.application.submitted");
    return { ok: true, created: true, state: { state: "pending", application: toView(rows[0]) } };
  } catch (err) {
    // Două trimiteri simultane: indexul unic parțial (0063) lasă doar una.
    if ((err as { code?: string }).code === "23505") {
      return { ok: true, created: false, state: await getApplicationState(userId) };
    }
    throw err;
  }
}
