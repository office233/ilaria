import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const CLIENTS_PAGE_SIZE = 100;

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const CreateClientSchema = z.object({
  name: z.string().trim().min(1, "Numele clientului este obligatoriu.").max(200),
  cui: optionalText(32),
  regCom: optionalText(32),
  phone: optionalText(32),
  email: z.string().trim().email().max(254).optional().or(z.literal("")).transform((v) => v || null),
  address: optionalText(500),
  city: optionalText(100),
  county: optionalText(100),
  notes: optionalText(2000),
});

export const GET = withErrorHandling(async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const { rows } = await dbQuery(
    `SELECT id, name, cui, reg_com, phone, email, address, city, county, notes, created_at
       FROM seller_clients
      WHERE seller_id = $1
      ORDER BY name ASC
      LIMIT $2`,
    [sellerId, CLIENTS_PAGE_SIZE],
  );

  return NextResponse.json({ success: true, clients: rows });
});

export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("sellerClients", sellerId);
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const parsed = parseBody(CreateClientSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: "validation_error", issues: parsed.issues },
      { status: 400 },
    );
  }
  const c = parsed.data;

  const { rows } = await dbQuery<{
    id: string;
    name: string;
    cui: string | null;
    reg_com: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    city: string | null;
    county: string | null;
    notes: string | null;
    created_at: string;
  }>(
    `INSERT INTO seller_clients (seller_id, name, cui, reg_com, phone, email, address, city, county, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, name, cui, reg_com, phone, email, address, city, county, notes, created_at`,
    [sellerId, c.name, c.cui, c.regCom, c.phone, c.email, c.address, c.city, c.county, c.notes],
  );

  return NextResponse.json({ success: true, client: rows[0] }, { status: 201 });
});
