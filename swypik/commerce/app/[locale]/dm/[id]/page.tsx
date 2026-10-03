import { notFound } from "next/navigation";
import { conversationPath } from "@/lib/dm/links";
import { redirect } from "@/lib/i18n/navigation";
import { isUuidParam } from "@/lib/validation/params";

/** Link-uri vechi din notificări/push (`/dm/<id>`, înainte 404) → conversația. */
export default async function LegacyDmRedirect({ params }: { params: Promise<{ id: string; locale: string }> }) {
  const { id, locale } = await params;
  if (!isUuidParam(id)) notFound();
  return redirect({ href: conversationPath(id), locale });
}
