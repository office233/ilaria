import { getAccountUserId } from "@/lib/social/session";
import { getOrCreateDmConversation } from "@/lib/dm/repository";
import { parseDmEntry, resolveDmPeer } from "@/lib/dm/entry-points";
import { conversationPath, dmEntryHref, INBOX_PATH } from "@/lib/dm/links";
import { isEnabled } from "@/lib/feature-flags";
import { redirect as redirectTo } from "next/navigation";
import { redirect } from "@/lib/i18n/navigation";
import { loginHref } from "@/lib/auth/login-redirect";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Punctul unic de intrare în chat: `/messages/new?user|seller|order|food_order=<id>`.
 * Rezolvă interlocutorul pe server (cu verificare de acces), deschide DM-ul
 * și redirecționează în `/messages/<id>`.
 */
export default async function NewMessagePage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isEnabled("dm") && !isEnabled("messenger")) return redirect({ href: INBOX_PATH, locale });

  const entry = parseDmEntry(await searchParams);
  if (!entry) return redirect({ href: INBOX_PATH, locale });

  // Cont real obligatoriu (fără shell anonim creat la randare).
  const userId = await getAccountUserId();
  if (!userId) {
    redirectTo(loginHref(locale, dmEntryHref(entry)));
  }

  let target = INBOX_PATH;
  try {
    const peerId = await resolveDmPeer(entry, userId);
    if (peerId) {
      const { conversationId } = await getOrCreateDmConversation(userId, peerId);
      target = conversationPath(conversationId);
    }
  } catch (err) {
    // Blocat / peer inexistent: înapoi în Inbox, fără pagină de eroare.
    logger.info({ err, kind: entry.kind }, "[dm] entry point not resolved");
  }
  return redirect({ href: target, locale });
}
