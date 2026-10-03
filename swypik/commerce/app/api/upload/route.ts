/**
 * Upload generic de imagini → S3/MinIO (bucket swypik-media).
 *
 * POST /api/upload  (multipart/form-data: file, scope?)
 *   Auth: user logat sau seller session.
 *   MIME-ul e validat din CONȚINUT (magic bytes în lib/storage/upload),
 *   nu din headerul clientului. Doar png/jpg/webp, max 5MB.
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { uploadFile, isStorageConfigured, MAX_FILE_SIZE } from "@/lib/storage/upload";
import { withErrorHandling } from "@/lib/api-handler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const SCOPE_RE = /^[a-z0-9_-]{1,40}$/;

/** Detectează MIME din magic bytes — sursa de adevăr, nu headerul. */
function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return null;
}

async function POST_impl(req: Request): Promise<Response> {
  const [session, sellerId] = await Promise.all([getAuthSession(), getSellerSessionId()]);
  const identity = sellerId ? `seller:${sellerId}` : session ? `user:${session.userId}` : null;
  if (!identity) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit("upload", identity, { limit: 20, window: 300 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  if (!isStorageConfigured()) {
    return NextResponse.json({ success: false, error: "Storage indisponibil." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ success: false, error: "Trimite multipart/form-data." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: "Câmpul `file` lipsește." }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { success: false, error: `Fișier gol sau peste ${MAX_FILE_SIZE / (1024 * 1024)}MB.` },
      { status: 400 },
    );
  }

  // Extensie permisă: png/jpg/jpeg/webp
  const name = (file.name || "upload").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
  if (!EXT_TO_MIME[ext]) {
    return NextResponse.json(
      { success: false, error: "Extensie nepermisă. Permise: png, jpg, jpeg, webp." },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // MIME din conținut — nu din header
  const realMime = sniffMime(buffer);
  if (!realMime || !ALLOWED.has(realMime)) {
    return NextResponse.json(
      { success: false, error: "Conținutul nu este o imagine validă (png/jpg/webp)." },
      { status: 400 },
    );
  }
  if (EXT_TO_MIME[ext] !== realMime) {
    return NextResponse.json(
      { success: false, error: "Extensia nu corespunde conținutului fișierului." },
      { status: 400 },
    );
  }

  const scopeRaw = String(form.get("scope") ?? "general");
  const scope = SCOPE_RE.test(scopeRaw) ? scopeRaw : "general";
  const now = new Date();
  const keyPrefix = `uploads/${scope}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;

  const result = await uploadFile(buffer, file.name || `upload.${ext}`, realMime, { keyPrefix });

  logger.info({ identity, key: result.key, size: result.size, scope }, "[upload] image uploaded");
  return NextResponse.json({ success: true, url: result.url, key: result.key, size: result.size });
}

export const POST = withErrorHandling(POST_impl);
