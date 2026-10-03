import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthSession } from "@/lib/auth/session";
import { loginHref } from "@/lib/auth/login-redirect";
import { dbQuery } from "@/lib/db";
import DeleteAccountClient from "./DeleteAccountClient";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "authEmail.deleteAccount" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Ștergerea contului din aplicație (cerință App Store / Google Play). */
export default async function DeleteAccountPage({ params }: Props) {
  const { locale } = await params;
  const session = await getAuthSession();
  if (!session) redirect(loginHref(locale, "/account/delete"));
  const { rows } = await dbQuery<{ username: string; has_password: boolean }>(
    `SELECT username, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1`,
    [session.userId],
  );
  const user = rows[0];
  if (!user) redirect(loginHref(locale, "/account/delete"));
  return <DeleteAccountClient username={user.username} hasPassword={user.has_password} />;
}
