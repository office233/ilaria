/**
 * POST /api/users/me/avatar — avatar nou pentru utilizatorul curent.
 *
 * multipart/form-data, câmpul `avatar` (jpg/png/webp, max 5MB). Imaginea e
 * decodată cu sharp (un fișier care doar pretinde că e imagine e respins),
 * rotită după EXIF, curățată de metadate (GPS!) și redusă la 512px WebP, apoi
 * urcată în storage-ul existent (`uploadFile`, prefix `avatars/<userId>`).
 * Moderare Azure AI Content Safety: „block” → 422 `avatar_rejected`; „review” sau
 * AI indisponibil → avatarul se salvează și se deschide un caz pe utilizator.
 * Erorile sunt coduri stabile, traduse pe client. 3 încărcări/oră per user.
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";
import { uploadFile, MAX_FILE_SIZE } from "@/lib/storage/upload";
import { logger } from "@/lib/logger";
import { moderateImage, needsReview } from "@/lib/moderation/ai-image";
import { openModerationCase } from "@/lib/moderation/cases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_PX = 512;

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** Normalizare avatar: pătrat 512px WebP, fără metadate. Aruncă dacă nu e imagine validă. */
async function normalizeAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(AVATAR_PX, AVATAR_PX, { fit: "cover", position: "attention" })
    .webp({ quality: 82 })
    .toBuffer();
}

export async function POST(request: Request) {
  const session = await getAuthSession();
  if (!session) return fail("unauthorized", 401);

  const { success } = await rateLimit("avatar_upload", session.userId, { limit: 3, window: 3600 });
  if (!success) return fail("rate_limited", 429);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("invalid_form");
  }

  const file = form.get("avatar");
  if (!(file instanceof File)) return fail("avatar_required");
  if (!ALLOWED_AVATAR_TYPES.has(file.type)) return fail("avatar_type");
  if (file.size === 0) return fail("avatar_empty");
  if (file.size > MAX_FILE_SIZE) return fail("avatar_too_large");

  let processed: Buffer;
  try {
    processed = await normalizeAvatar(Buffer.from(await file.arrayBuffer()));
  } catch {
    return fail("avatar_invalid_image");
  }

  const moderation = await moderateImage(processed, "image.avatar");
  if (moderation.decision === "block") return fail("avatar_rejected", 422);

  try {
    const result = await uploadFile(processed, "avatar.webp", "image/webp", {
      keyPrefix: `avatars/${session.userId}`,
    });
    await dbQuery(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [result.url, session.userId]);
    if (needsReview(moderation)) {
      void openModerationCase({
        target: { kind: "user", id: session.userId },
        source: "image_ai",
        reasons: moderation.reasons,
        severity: moderation.decision === "unavailable" ? "low" : "medium",
        metadata: { kind: "avatar", url: result.url },
      });
    }
    return NextResponse.json({ avatar_url: result.url });
  } catch (err: unknown) {
    logger.error({ err }, "[users/me/avatar POST]");
    return fail("avatar_upload_failed", 500);
  }
}
