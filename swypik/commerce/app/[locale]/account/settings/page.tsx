import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const auth = await getAuthUser();
  if (auth.role === "guest" || !auth.userId) {
    redirect("/auth/login?next=/account/settings");
  }

  // Fetch user email + seller status
  let sellerStatus: string | null = null;
  try {
    const { rows } = await dbQuery<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1`,
      [auth.userId],
    );
    const email = rows[0]?.email;
    if (email) {
      const sr = await dbQuery<{ status: string }>(
        `SELECT status FROM sellers WHERE email = $1`,
        [email],
      );
      sellerStatus = sr.rows[0]?.status ?? null;
    }
  } catch {}

  return <SettingsClient isAdmin={auth.role === "admin"} sellerStatus={sellerStatus} />;
}
