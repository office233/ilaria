import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody, SellerSettingsUpdateSchema } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { normalizeRoCounty } from "@/lib/seller/efactura/counties";
import { parseCui, validCui } from "@/lib/seller/efactura/cui";
import { INVOICE_DEFAULT_SERIES } from "@/lib/seller/invoicing";

/** Răspunsurile de eroare poartă doar coduri stabile — textul îl traduce clientul. */
function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) return fail("unauthorized", 401);

    const rl = await rateLimit("sellerSettings", sellerId);
    if (!rl.success) return fail("rate_limited", 429);

    const parsed = parseBody(SellerSettingsUpdateSchema, await req.json().catch(() => null));
    if (!parsed.ok) return fail("validation_error", 400);
    const d = parsed.data;

    const cleanUsername = d.username.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (cleanUsername.length < 3) return fail("handle_too_short", 400);

    // CUI gol e permis (profil incomplet); unul completat trebuie să fie valid
    // (cifra de control) — altfel ar ajunge pe facturi/e-Factura.
    const cuiInput = d.cui?.trim() || "";
    if (cuiInput && !validCui(cuiInput)) return fail("invalid_cui", 400);
    const parsedCui = parseCui(cuiInput);
    const cui = parsedCui ? `${parsedCui.vatRegistered ? "RO" : ""}${parsedCui.digits}` : null;

    const { rows: sellerRows } = await dbQuery<{ user_id: string | null; business_details: Record<string, unknown> | null }>(
      "SELECT user_id, business_details FROM sellers WHERE id = $1",
      [sellerId],
    );
    if (sellerRows.length === 0) return fail("seller_not_found", 404);

    const currentSeller = sellerRows[0];
    const userId = currentSeller.user_id;

    if (userId) {
      const { rows: existingUsers } = await dbQuery(
        "SELECT id FROM users WHERE lower(username) = $1 AND id != $2 LIMIT 1",
        [cleanUsername, userId],
      );
      if (existingUsers.length > 0) return fail("handle_taken", 409);
    }

    const country = (d.country || "RO").toUpperCase();
    const updatedBusinessDetails = {
      ...(currentSeller.business_details || {}),
      description: d.bio || "",
      iban: d.iban || "",
      invoiceSeries: d.invoiceSeries || INVOICE_DEFAULT_SERIES,
      legalName: d.legalName || "",
      tradeRegister: d.tradeRegister || "",
      address: d.street || "",
      city: d.city || "",
      county: country === "RO" ? normalizeRoCounty(d.county) ?? "" : d.county || "",
      postalCode: d.postalCode || "",
      country,
      vatExemptionReason: d.vatExemptionReason || "",
    };

    // Numele magazinului e obligatoriu în formular; fără el păstrăm numele existent.
    await dbQuery(
      `UPDATE sellers
          SET name = COALESCE(NULLIF($1, ''), name), cui = $2, phone = $3, business_details = $4, updated_at = NOW()
        WHERE id = $5`,
      [d.name?.trim() || "", cui, d.phone?.trim() || null, updatedBusinessDetails, sellerId],
    );

    if (userId) {
      await dbQuery(
        `UPDATE users
            SET username = $1, display_name = COALESCE(NULLIF($2, ''), display_name), bio = $3,
                avatar_url = COALESCE(NULLIF($4, ''), avatar_url), updated_at = NOW()
          WHERE id = $5`,
        [cleanUsername, d.name?.trim() || "", d.bio?.trim() || "", d.avatarUrl?.trim() || "", userId],
      );
    }

    return NextResponse.json({ ok: true, username: cleanUsername, profileUrl: `/u/${cleanUsername}` });
  } catch (error) {
    logger.error({ err: error }, "[Seller Settings API] Error");
    return fail("internal_error", 500);
  }
}
