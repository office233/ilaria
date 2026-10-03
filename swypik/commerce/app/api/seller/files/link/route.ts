/**
 * POST /api/seller/files/link — link semnat, de scurtă durată, către un fișier
 * al sellerului (PDF/XML), ca să poată fi deschis în browserul sistemului sau
 * în foaia de partajare din aplicația mobilă (unde cookie-ul de sesiune nu
 * ajunge). Ruta fișierului verifică din nou că documentul aparține sellerului.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { APP_URL } from "@/lib/app-url";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { SELLER_FILE_KINDS, sellerFileLinkTtlMs, sellerFilePath, signSellerFileToken } from "@/lib/seller/file-links";
import { sellerRequestLocale } from "@/lib/seller/request-locale";

export const dynamic = "force-dynamic";

const LinkSchema = z.object({
  kind: z.enum(SELLER_FILE_KINDS),
  id: z.string().uuid(),
});

export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("sellerFiles", sellerId, { limit: 60, window: 60 });
  if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(LinkSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });

  const { kind, id } = parsed.data;
  const token = signSellerFileToken(sellerId, kind, id);
  const locale = await sellerRequestLocale();
  return NextResponse.json(
    {
      success: true,
      url: `${APP_URL}${sellerFilePath(kind, id)}?t=${encodeURIComponent(token)}&locale=${locale}`,
      expiresInSeconds: Math.round(sellerFileLinkTtlMs() / 1000),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
