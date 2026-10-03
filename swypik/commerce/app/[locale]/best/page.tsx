import { getLocale } from "next-intl/server";
import { permanentRedirect } from "@/lib/i18n/navigation";
import type { Locale } from "@/lib/i18n/config";

export default async function Page() {
  const locale = (await getLocale()) as Locale;
  permanentRedirect({ href: "/explore", locale });
}
