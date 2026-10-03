/**
 * POST /api/merchants/apply — aplicație publică de restaurant/comerciant (fără cont de seller).
 *
 * Creează un rând în `local_merchants` cu status='pending' și seller_id NULL.
 * Aplicația apare în coada unificată /admin/aplicatii, unde adminul o aprobă/respinge.
 * Dacă aplicantul e logat, se creează și o cerere de revendicare
 * (/admin/merchant-claims) — aprobarea ei leagă sellerul și activează comenzile.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { getAuthSession } from "@/lib/auth/session";
import { merchantSlug } from "@/lib/merchants/slug";
import { createClaim } from "@/lib/food/claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MerchantApplySchema = z.object({
  name: z.string().trim().min(2, "Nume prea scurt").max(160),
  address: z.string().trim().min(5, "Adresă prea scurtă").max(400),
  city: z.string().trim().min(2, "Orașul e obligatoriu").max(120),
  phone: z.string().trim().min(5, "Telefon invalid").max(32),
  email: z.string().trim().email().max(254).optional().or(z.literal("")),
  schedule: z.string().trim().max(400).optional(),
  description: z.string().trim().max(2000).optional(),
  // Țara (ISO-2); implicit țara platformei (PLATFORM_DEFAULT_COUNTRY) — audit food-go #24.
  country: z.string().trim().length(2).toUpperCase().optional(),
});

const DEFAULT_COUNTRY = (process.env.PLATFORM_DEFAULT_COUNTRY || "RO").trim().toUpperCase().slice(0, 2);

export async function POST(req: Request) {
  try {
    const ip = getClientIP(req);
    const rl = await rateLimit("merchantApply", ip, { limit: 3, window: 3600 });
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = parseBody(MerchantApplySchema, raw);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
    }
    const d = parsed.data;

    // Programul (text liber) se păstrează în descriere până la structurare de către admin.
    const description = [d.description, d.schedule ? `Program: ${d.schedule}` : null]
      .filter(Boolean)
      .join("\n") || null;

    const slug = merchantSlug(d.name);

    const { rows } = await dbQuery(
      `INSERT INTO local_merchants (
         kind, name, slug, description, phone, email, address,
         location_country, location_city, status
       ) VALUES ('restaurant', $1, $2, $3, $4, $5, $6, $8, $7, 'pending')
       RETURNING id`,
      [d.name, slug, description, d.phone, d.email || null, d.address, d.city, d.country ?? DEFAULT_COUNTRY],
    );

    // Aplicantul logat devine automat solicitantul revendicării: la aprobarea
    // din /admin/merchant-claims primește panoul de restaurant (seller legat),
    // în loc de un profil activ fără proprietar (fundătura de dinainte).
    const session = await getAuthSession();
    let claimId: string | null = null;
    if (session?.userId && rows[0]?.id) {
      const claim = await createClaim({
        merchantId: rows[0].id,
        userId: session.userId,
        contactPhone: d.phone,
        contactEmail: d.email || null,
      });
      claimId = claim.ok ? claim.claimId : null;
    }

    return NextResponse.json({ success: true, id: rows[0]?.id, claim_id: claimId }, { status: 201 });
  } catch (error: unknown) {
    logger.error({ err: error }, "[merchants/apply] POST error");
    return NextResponse.json({ success: false, error: "Eroare la trimiterea aplicației." }, { status: 500 });
  }
}
