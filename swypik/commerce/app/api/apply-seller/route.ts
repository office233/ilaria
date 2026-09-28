import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { SellerApplicationSchema, parseBody } from "@/lib/validation/schemas";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
import { sendOpsApplicationAlert } from "@/lib/email/templates/ops";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const rl = await rateLimit("applySeller", getClientIP(req));
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const rawBody = await req.json().catch(() => null);
    const parsed = parseBody(SellerApplicationSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const { companyName, cui, email, phone, productType } = parsed.data;

    const normalizedEmail = email.toLowerCase();
    const businessDetails = {
      cui,
      phone,
      product_type: productType,
    };

    // Reaplicarea cu un email deja existent NU trebuie sa poata reseta la
    // 'pending' (sau sa suprascrie datele) unui seller deja activ/aprobat/
    // suspendat — altfel oricine ar putea retrograda un cont existent doar
    // stiindu-i emailul public. Update-ul se aplica DOAR peste cereri inca
    // in asteptare sau respinse anterior.
    const saved = await dbQuery<{ id: string }>(
      `
      INSERT INTO sellers (name, cui, email, phone, product_type, status, business_details)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        cui = EXCLUDED.cui,
        phone = EXCLUDED.phone,
        product_type = EXCLUDED.product_type,
        status = 'pending',
        business_details = EXCLUDED.business_details,
        updated_at = now()
      WHERE sellers.status IN ('pending', 'rejected')
      RETURNING id
      `,
      [companyName, cui, normalizedEmail, phone, productType, JSON.stringify(businessDetails)],
    );

    // Nimic scris = emailul aparține deja unui seller activ/aprobat/suspendat.
    // Răspundem identic (fără a dezvălui dacă emailul are cont), dar nu anunțăm ops.
    const written = saved.rows.length > 0;
    if (!written) {
      logger.info({ email: normalizedEmail }, "[apply-seller] re-application ignored for existing non-pending seller");
    }

    // Notifică ops: aplicație nouă de vânzător (best-effort; escaparea e în lib/email).
    if (written) {
      sendOpsApplicationAlert({
        kind: "seller",
        label: companyName,
        fields: { company: companyName, cui, email: normalizedEmail, phone, products: productType },
        adminPath: "/admin/sellers",
      }).catch((err) => logger.warn({ err }, "[apply-seller] ops email failed"));
    }

    return NextResponse.json({ success: true, status: "received" });
  } catch (error: any) {
    logger.error({ err: error }, "[Apply Seller API] Error:");
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 },
    );
  }
}
