import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { ArrowLeft, Globe, Coins } from "lucide-react";
import LocaleSwitcher from "@/components/i18n/LocaleSwitcher";
import { CurrencySwitcher } from "@/components/i18n/CurrencyProvider";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  // Doar pentru a se asigura că rulează server-side cu acces la cookies / locale.
  await cookies();
  const tCommon = await getTranslations("common");
  const tSettings = await getTranslations("settings");

  return (
    <main className="min-h-screen bg-[#0D0D0D] text-white mobile-page-bottom">
      <header className="relative z-30 bg-[#0D0D0D]/95 backdrop-blur-md border-b border-white/10 px-4 py-4 flex items-center justify-between">
        <Link
          href="/account/settings"
          className="grid h-11 w-11 place-items-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition"
          aria-label={tCommon("language")}
        >
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-lg font-black">{tSettings("preferences")}</h1>
        <div className="w-11" aria-hidden="true" />
      </header>

      <div className="mx-auto max-w-md px-4 py-6">
        <section className="space-y-4">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-white/80 mb-2">
              <Globe size={16} className="text-[#F5A623]" />
              {tSettings("selectLanguage")}
            </label>
            <LocaleSwitcher className="w-full rounded-xl border border-white/10 bg-[#1A1A1A] px-3 py-3 text-white text-[15px] appearance-none" />
          </div>

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
            <label className="flex items-center gap-2 text-sm font-semibold text-white/80 mb-2">
              <Coins size={16} className="text-[#F5A623]" />
              {tSettings("selectCurrency")}
            </label>
            <CurrencySwitcher className="w-full rounded-xl border border-white/10 bg-[#1A1A1A] px-3 py-3 text-white text-[15px] appearance-none" />
          </div>
        </section>
      </div>
    </main>
  );
}
