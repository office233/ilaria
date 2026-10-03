import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { UserAddressCreateSchema, parseBody } from "@/lib/validation/schemas";
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
