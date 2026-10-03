/**
 * Un produs al seller-ului.
 *   GET    → produsul + variantele (formularul de editare)
 *   PATCH  → editare parțială (lib/seller/product-schemas: preț, stoc, imagini,
 *            categorie, livrare, status, variante)
 *   DELETE → arhivare (nu ștergere — produsul poate apărea în comenzi)
 */
import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { SellerProductUpdateSchema } from "@/lib/seller/product-schemas";
import {
  archiveSellerProduct,
  getSellerProduct,
  updateSellerProduct,
  upsertSellerProductTranslation,
} from "@/lib/seller/products";
import { sellerRequestLocale, sellerTranslationTargets } from "@/lib/seller/request-locale";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { autoEmbedProduct } from "@/lib/ai/auto-embed";
import { translateProductToLocales } from "@/lib/ai/product-translator";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type Guard = { ok: false; error: Response } | { ok: true; id: string; sellerId: string };

async function guard(req: Request, ctx: Ctx, mutating: boolean): Promise<Guard> {
  const { id } = await ctx.params;
  if (!isUuidParam(id)) return { ok: false, error: invalidIdResponse() };
  const sellerId = await getSellerSessionId();
  if (!sellerId) return { ok: false, error: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) };
  if (mutating) {
    const rl = await rateLimit("sellerProductEdit", sellerId);
    if (!rl.success) return { ok: false, error: NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 }) };
  }
  return { ok: true, id, sellerId };
}

const notFound = () => NextResponse.json({ success: false, error: "not_found" }, { status: 404 });

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const g = await guard(req, ctx, false);
  if (!g.ok) return g.error;
  try {
    const product = await getSellerProduct(g.sellerId, g.id);
    return product ? NextResponse.json({ success: true, product }) : notFound();
  } catch (err) {
    logger.error({ err, productId: g.id }, "[seller/products/:id] GET failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const g = await guard(req, ctx, true);
  if (!g.ok) return g.error;

  const parsed = SellerProductUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const code = parsed.error.issues.find((i) => i.message === "invalid_shipping_days") ? "invalid_shipping_days" : "validation_error";
    return NextResponse.json({ success: false, error: code }, { status: 400 });
  }
  const d = parsed.data;

  try {
    const res = await updateSellerProduct(g.sellerId, g.id, d);
    if (!res.ok) return res.code === "not_found" ? notFound() : NextResponse.json({ success: false, error: res.code }, { status: 422 });

    if (res.textChanged) {
      const p = res.product as { id: string; title: string; description: string | null; category: string | null };
      autoEmbedProduct(p.id, p.title, p.description);
      labelProduct({ id: p.id, title: p.title, description: p.description, category: p.category }).catch(() => {});
      const locale = await sellerRequestLocale();
      await upsertSellerProductTranslation({ productId: p.id, locale, title: p.title, description: p.description, slug: null }).catch(
        (err) => logger.warn({ err, productId: p.id }, "[seller/products/:id] translation upsert failed"),
      );
      translateProductToLocales({
        productId: p.id,
        sourceLocale: locale,
        title: p.title,
        description: p.description,
        targetLocales: sellerTranslationTargets(locale),
      }).catch((err) => logger.warn({ err, productId: p.id }, "[seller/products/:id] translate fanout failed"));
    }
    return NextResponse.json({ success: true, product: res.product });
  } catch (err) {
    logger.error({ err, productId: g.id }, "[seller/products/:id] PATCH failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const g = await guard(req, ctx, true);
  if (!g.ok) return g.error;
  try {
    return (await archiveSellerProduct(g.sellerId, g.id)) ? NextResponse.json({ success: true, status: "archived" }) : notFound();
  } catch (err) {
    logger.error({ err, productId: g.id }, "[seller/products/:id] DELETE failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
