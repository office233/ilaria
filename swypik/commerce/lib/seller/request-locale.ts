import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n/config";

/** Limba în care seller-ul scrie textele produsului (cookie-ul de locale). */
export async function sellerRequestLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Limbile în care se traduce automat un produs scris în `source`. */
export function sellerTranslationTargets(source: Locale): Locale[] {
  return source === "ro" ? ["en"] : ["ro"];
}
