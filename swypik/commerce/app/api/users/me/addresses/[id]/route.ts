import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";
import { AddressPatchSchema, parseBody } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = [
  "label",
  "recipient_name",
  "phone",
  "line1",
  "line2",
  "city",
  "region",
  "postal_code",
  "country_code",
    "lat",
    "lng",
    "details",
] as const;

async function PATCH_impl(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("userAddresses", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;
  const rawBody = await req.json().catch(() => null);
  const parsed = parseBody(AddressPatchSchema, rawBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const body = parsed.data;

  // Ownership check
  const { rows: owner } = await dbQuery<{ id: string }>(
    `SELECT id FROM user_addresses WHERE id = $1 AND user_id = $2`,
    [id, session.userId],
  );
  if (owner.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (body.set_default === true) {
    await dbQuery(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [session.userId]);
    await dbQuery(`UPDATE user_addresses SET is_default = true, updated_at = now() WHERE id = $1`, [id]);
    return NextResponse.json({ success: true });
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const field of ALLOWED_FIELDS) {
    if (field in body) {
      const v = (body as Record<string, unknown>)[field];
      values.push(v === "" ? null : v);
      setClauses.push(`${field} = $${values.length}`);
    }
  }
  if (setClauses.length === 0) return NextResponse.json({ success: true });
  values.push(id);
  await dbQuery(
    `UPDATE user_addresses SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
    values,
  );
  return NextResponse.json({ success: true });
}

async function DELETE_impl(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAuthSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = await rateLimit("userAddresses", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;
  const { rows } = await dbQuery<{ is_default: boolean }>(
    `DELETE FROM user_addresses WHERE id = $1 AND user_id = $2 RETURNING is_default`,
    [id, session.userId],
  );
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Promote a remaining one to default if we just deleted the default
  if (rows[0].is_default) {
    await dbQuery(
      `UPDATE user_addresses SET is_default = true
       WHERE id = (SELECT id FROM user_addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [session.userId],
    );
  }
  return NextResponse.json({ success: true });
}

export const PATCH = withErrorHandling(PATCH_impl);
export const DELETE = withErrorHandling(DELETE_impl);
