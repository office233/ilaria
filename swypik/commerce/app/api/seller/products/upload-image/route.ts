import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { uploadFile, isStorageConfigured } from "@/lib/storage/upload";
import { logger } from "@/lib/logger";
import { moderateImage } from "@/lib/moderation/ai-image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** MIME din magic bytes — sursa de adevăr, nu headerul clientului (audit P0). */
function sniffImageMime(buf: Buffer): string | null {
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

export async function POST(req: Request) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

    if (!isStorageConfigured()) {
      return NextResponse.json({ success: false, error: "storage_unavailable" }, { status: 503 });
    }

    const rl = await rateLimit("sellerUploadImage", sellerId, { limit: 60, window: 300 });
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ success: false, error: "file_missing" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      return NextResponse.json({ success: false, error: "file_too_large" }, { status: 413 });
    }
    // Validare din conținut, nu din headerul clientului — blochează SVG/HTML/JS
    // deghizate în imagini (XSS stocat).
    const mimeType = sniffImageMime(buffer);
    if (!mimeType) {
      return NextResponse.json({ success: false, error: "unsupported_format" }, { status: 415 });
    }
    // Azure AI Content Safety: doar „block” respinge; „review” trece (produsul are
    // propria moderare la publicare), dar rămâne semnalat în log pentru audit.
    const moderation = await moderateImage(buffer, "image.product");
    if (moderation.decision === "block") {
      return NextResponse.json({ success: false, code: "image_rejected" }, { status: 422 });
    }
    if (moderation.decision === "review") {
      logger.warn({ sellerId, reasons: moderation.reasons }, "[seller/upload-image] image flagged for review");
    }
    const rawName = (form?.get("filename") as string) || "image";
    const name = rawName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "image";

    const result = await uploadFile(buffer, name, mimeType, {
      keyPrefix: `products/seller/${sellerId}/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}`,
    });

    return NextResponse.json({ success: true, url: result.url, key: result.key, size: result.size });
  } catch (error: any) {
    logger.warn({ err: error?.message }, "[seller/upload-image] error");
    return NextResponse.json({ success: false, error: error?.message || "Upload eșuat." }, { status: 400 });
  }
}
