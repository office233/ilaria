import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { UserAddressCreateSchema, parseBody, ALLOWED_COUNTRY_CODES } from "@/lib/validation/schemas";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

type Address = {
  id: string;
  label: string | null;
  recipient_name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country_code: string;
  is_default: boolean;
  lat: number | null;
  lng: number | null;
  details: string | null;
  created_at: string;
};

// 2026-08-11 (audit): lista vine din lib/validation/schemas — o singură sursă.
const ALLOWED_COUNTRIES: readonly string[] = ALLOWED_COUNTRY_CODES;

function validate(body: Record<string, unknown>): { ok: true; data: Omit<Address, "id" | "created_at"> } | { ok: false; error: string } {
  const recipient_name = String(body.recipient_name || "").trim();
  const line1 = String(body.line1 || "").trim();
  const city = String(body.city || "").trim();
  const postal_code = String(body.postal_code || "").trim();
  const country_code = String(body.country_code || "RO").toUpperCase();
  if (!recipient_name) return { ok: false, error: "Numele destinatarului este obligatoriu." };
  if (!line1) return { ok: false, error: "Strada (linia 1) este obligatorie." };
  if (!city) return { ok: false, error: "Orașul este obligatoriu." };
  if (!postal_code) return { ok: false, error: "Codul poștal este obligatoriu." };
  if (!ALLOWED_COUNTRIES.includes(country_code)) return { ok: false, error: "Țara selectată nu este suportată." };
  return {
    ok: true,
    data: {
      label: body.label ? String(body.label).trim() || null : null,
      recipient_name,
      phone: body.phone ? String(body.phone).trim() || null : null,
      line1,
      line2: body.line2 ? String(body.line2).trim() || null : null,
      city,
      region: body.region ? String(body.region).trim() || null : null,
      postal_code,
      country_code,
      is_default: Boolean(body.is_default),
      lat: body.lat != null && Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
      lng: body.lng != null && Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
      details: body.details ? String(body.details).trim().slice(0, 500) || null : null,
    },
  };
}

async function GET_impl() {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { rows } = await dbQuery<Address>(
    `SELECT id, label, recipient_name, phone, line1, line2, city, region, postal_code,
              country_code, is_default, lat, lng, details, created_at
     FROM user_addresses WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [session.userId],
  );
  return NextResponse.json({ addresses: rows });
}

async function POST_impl(req: Request) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("userAddresses", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const rawBody = await req.json().catch(() => ({}));
  const parsed = parseBody(UserAddressCreateSchema, rawBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code, issues: parsed.issues }, { status: 400 });
  const data = parsed.data;
  let isDefault = Boolean(data.is_default);

  if (isDefault) {
    await dbQuery(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [session.userId]);
  } else {
    const { rows: existing } = await dbQuery<{ c: string }>(
      `SELECT count(*)::text c FROM user_addresses WHERE user_id = $1`,
      [session.userId],
    );
    if (existing[0]?.c === "0") isDefault = true;
  }

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO user_addresses
        (user_id, label, recipient_name, phone, line1, line2, city, region, postal_code, country_code, is_default, lat, lng, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      session.userId,
      data.label ?? null,
      data.recipient_name,
      data.phone ?? null,
      data.line1,
      data.line2 ?? null,
      data.city,
      data.region ?? null,
      data.postal_code,
      data.country_code,
      isDefault,
      data.lat ?? null,
      data.lng ?? null,
      data.details ?? null,
    ],
  );
  return NextResponse.json({ success: true, id: rows[0].id });
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
