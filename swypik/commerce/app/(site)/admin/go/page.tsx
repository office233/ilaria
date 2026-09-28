/**
 * /admin/go — consola Swypik Go: dispatch live (hartă + curse active +
 * atribuire/reatribuire/anulare), tarife + setări, șoferi (aprobare,
 * suspendare, documente). Toate mutațiile sunt auditate (admin_audit_log).
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireAdminPage } from "@/lib/admin/guard";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import GoConsole from "@/components/admin/go/GoConsole";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminGo");
  return { title: t("title"), robots: { index: false } };
}

export default async function AdminGoPage() {
  if (!(await requireAdminPage("mobility"))) return <AdminForbidden />;
  return <GoConsole />;
}
