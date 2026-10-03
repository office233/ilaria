import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { assertParticipant } from "@/lib/dm/repository";
import { DM_CONFIG } from "@/lib/dm/config";
import { conversationPath } from "@/lib/dm/links";
import { isEnabled } from "@/lib/feature-flags";
import { redirect } from "next/navigation";
import { loginHref } from "@/lib/auth/login-redirect";
import { getAccountUserId } from "@/lib/social/session";
import { isUuidParam } from "@/lib/validation/params";
import ChatScreen from "@/components/messenger/chat/ChatScreen";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dm" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Ecranul unei conversații (full-height, BottomNav ascuns — vezi lib/nav/visibility). */
export default async function ConversationPage({ params }: Props) {
  const { id, locale } = await params;
  if (!isEnabled("messenger") && !isEnabled("dm")) notFound();
  if (!isUuidParam(id)) notFound();

  const userId = await getAccountUserId();
  if (!userId) redirect(loginHref(locale, conversationPath(id)));

  const ok = await assertParticipant(id, userId).catch(() => false);
  if (!ok) notFound();

  const limits = { maxBody: DM_CONFIG.maxBody, pageSize: DM_CONFIG.pageSize, maxImageMb: DM_CONFIG.attachmentMaxMb };
  return <ChatScreen conversationId={id} viewerId={userId} limits={limits} />;
}
