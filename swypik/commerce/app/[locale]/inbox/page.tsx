import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getAuthSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { loginHref } from "@/lib/auth/login-redirect";
import InboxClient, { type InboxTab } from "./InboxClient";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dm.inbox" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

export default async function InboxPage({ params, searchParams }: Props) {
  const [{ locale }, sp] = await Promise.all([params, searchParams]);
  const session = await getAuthSession();
  if (!session) redirect(loginHref(locale, "/inbox"));
  const initialTab: InboxTab = sp?.tab === "notifications" ? "notifications" : "messages";
  return <InboxClient viewerId={session.userId} initialTab={initialTab} />;
}
