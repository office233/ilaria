import { notFound } from "next/navigation";
import { isEnabled } from "@/lib/feature-flags";
import { redirect } from "@/lib/i18n/navigation";
import { conversationPath, INBOX_PATH } from "@/lib/dm/links";
import { isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ c?: string }>;
};

/**
 * Lista de conversații trăiește în Inbox (tab-ul Mesaje). `/messages?c=<id>`
 * (link-uri vechi) deschide direct conversația.
 */
export default async function MessagesIndexPage({ params, searchParams }: Props) {
  if (!isEnabled("messenger") && !isEnabled("dm")) notFound();
  const [{ locale }, sp] = await Promise.all([params, searchParams]);
  const target = sp?.c && isUuidParam(sp.c) ? conversationPath(sp.c) : `${INBOX_PATH}?tab=messages`;
  return redirect({ href: target, locale });
}
