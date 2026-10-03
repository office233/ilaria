import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

async function DELETE_impl(
  _req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("oauthUnlink", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { provider } = await ctx.params;
  if (provider !== "google" && provider !== "apple") {
    return NextResponse.json({ error: "invalid provider" }, { status: 400 });
  }

  // Lockout guard: require either password or another OAuth account.
  const guard = await dbQuery<{ has_password: boolean; other_oauth: number }>(
    `SELECT
       (u.password_hash IS NOT NULL) AS has_password,
       (SELECT COUNT(*)::int FROM oauth_accounts WHERE user_id = u.id AND provider <> $2) AS other_oauth
     FROM users u WHERE u.id = $1`,
    [session.userId, provider],
  );
  const row = guard.rows[0];
  if (!row) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  if (!row.has_password && Number(row.other_oauth) === 0) {
    return NextResponse.json(
      {
        error: "Setează o parolă sau conectează altă metodă de login înainte de a deconecta.",
      },
      { status: 400 },
    );
  }

  await dbQuery(
    `DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = $2`,
    [session.userId, provider],
  );
  return NextResponse.json({ ok: true });
}

export const DELETE = withErrorHandling(DELETE_impl);
