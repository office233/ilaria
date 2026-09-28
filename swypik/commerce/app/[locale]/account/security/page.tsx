import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/session";
import { dbQuery } from "@/lib/db";
import SecurityPageClient from "./SecurityPageClient";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await getAuthSession();
  if (!session) {
    redirect("/auth/login?next=/account/security");
  }

  const { rows } = await dbQuery<{ has_password: boolean; totp_enabled: boolean }>(
    `SELECT (password_hash IS NOT NULL) AS has_password,
            (totp_enabled_at IS NOT NULL) AS totp_enabled
     FROM users WHERE id = $1`,
    [session.userId],
  );
  const hasPassword = Boolean(rows[0]?.has_password);
  const totpEnabled = Boolean(rows[0]?.totp_enabled);

  const { rows: oauthRows } = await dbQuery<{ provider: string; email: string | null; created_at: string }>(
    `SELECT provider, email, created_at FROM oauth_accounts WHERE user_id = $1 ORDER BY created_at ASC`,
    [session.userId],
  );
  const connectedAccounts = oauthRows.map((r) => ({ provider: r.provider, email: r.email, createdAt: r.created_at }));

  return <SecurityPageClient hasPassword={hasPassword} totpEnabled={totpEnabled} connectedAccounts={connectedAccounts} />;
}
