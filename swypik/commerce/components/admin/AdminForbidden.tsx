import { getTranslations } from "next-intl/server";
import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

/** Adminul e logat, dar rolul lui nu are dreptul pentru pagina asta. */
export async function AdminForbidden() {
  const t = await getTranslations("adminConsole.common");
  return <EmptyState icon={Lock} title={t("forbiddenTitle")} description={t("forbiddenBody")} className="py-20" />;
}
