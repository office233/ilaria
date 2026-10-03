import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { withErrorHandling } from "@/lib/api-handler";
import { parseBody } from "@/lib/validation/schemas";
import { dbQuery } from "@/lib/db";
import { logAdminAction } from "@/lib/security/admin-audit";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const { rows } = await dbQuery(
        `SELECT p.user_id, p.approved_at, p.note, u.display_name, u.username, u.email
           FROM movie_publishers p JOIN users u ON u.id = p.user_id ORDER BY p.approved_at DESC`,
    );
    return NextResponse.json({ publishers: rows });
});

const BodySchema = z.object({ userId: z.string().uuid(), note: z.string().trim().max(500).optional() });

export const POST = withErrorHandling(async function POST(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = parseBody(BodySchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    await dbQuery(
        `INSERT INTO movie_publishers (user_id, approved_by, note) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET note = EXCLUDED.note`,
        [parsed.data.userId, auth.userId, parsed.data.note ?? null],
    );
    await logAdminAction({ action: "movie_publisher.approve", targetType: "user", targetId: parsed.data.userId, details: { note: parsed.data.note ?? null }, req });
    return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = withErrorHandling(async function DELETE(req: Request) {
    if (!isEnabled("movies")) return frozenResponse("movies");
    const auth = await requireAuth(req, ["admin"]);
    if (auth instanceof NextResponse) return auth;
    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    await dbQuery(`DELETE FROM movie_publishers WHERE user_id = $1`, [userId]);
    await logAdminAction({ action: "movie_publisher.remove", targetType: "user", targetId: userId, req });
    return NextResponse.json({ ok: true });
});
