import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CheckCircle2, MailX, AlertTriangle } from "lucide-react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n/config";
import { decodeEmailParam, verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

type SP = Promise<{ u?: string; t?: string; l?: string; done?: string; invalid?: string }>;

async function pageLocale(l?: string): Promise<Locale> {
  if (isLocale(l)) return l;
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(c) ? c : DEFAULT_LOCALE;
}

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const { l } = await searchParams;
  const t = await getTranslations({ locale: await pageLocale(l), namespace: "authEmail.unsubscribe" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * Confirmarea dezabonării: un GET nu dezabonează (scannerele de linkuri);
 * butonul trimite POST la /api/unsubscribe.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const locale = await pageLocale(sp.l);
  const t = await getTranslations({ locale, namespace: "authEmail.unsubscribe" });
  const email = decodeEmailParam(sp.u);
  const valid = Boolean(email && sp.t && verifyUnsubscribeToken(email, sp.t));
  const state = sp.done === "1" ? "done" : sp.invalid === "1" || !valid ? "invalid" : "confirm";
  const home = locale === DEFAULT_LOCALE ? "/" : `/${locale}`;
  const settings = `${locale === DEFAULT_LOCALE ? "" : `/${locale}`}/account/notifications`;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10 text-fg">
      <div className="w-full max-w-md rounded-2xl border border-subtle bg-surface p-8 text-center shadow-sm">
        <p className="mb-6 text-2xl font-black tracking-tight">Swypik</p>
        {state === "done" && (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-success" aria-hidden />
            <h1 className="mb-3 text-xl font-bold">{t("doneTitle")}</h1>
            <p className="mb-6 text-sm text-muted">{t("doneBody")}</p>
            <Link href={settings} className="text-sm font-semibold text-brand underline">
              {t("manage")}
            </Link>
          </>
        )}
        {state === "invalid" && (
          <>
            <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-warning" aria-hidden />
            <h1 className="mb-3 text-xl font-bold">{t("invalidTitle")}</h1>
            <p className="mb-6 text-sm text-muted">{t("invalidBody")}</p>
            <Link href={settings} className="text-sm font-semibold text-brand underline">
              {t("manage")}
            </Link>
          </>
        )}
        {state === "confirm" && email && (
          <>
            <MailX className="mx-auto mb-4 h-12 w-12 text-brand" aria-hidden />
            <h1 className="mb-3 text-xl font-bold">{t("confirmTitle")}</h1>
            <p className="mb-6 text-sm text-muted">{t("confirmBody", { email })}</p>
            <form method="post" action="/api/unsubscribe" className="space-y-3">
              <input type="hidden" name="u" value={sp.u} />
              <input type="hidden" name="t" value={sp.t} />
              <input type="hidden" name="l" value={locale} />
              <input type="hidden" name="form" value="1" />
              <button
                type="submit"
                className="min-h-[44px] w-full rounded-xl bg-brand px-4 py-3 font-bold text-brand-fg transition hover:bg-brand-hover"
              >
                {t("confirm")}
              </button>
            </form>
          </>
        )}
        <Link href={home} className="mt-6 inline-block text-sm text-muted underline">
          {t("home")}
        </Link>
      </div>
    </main>
  );
}
