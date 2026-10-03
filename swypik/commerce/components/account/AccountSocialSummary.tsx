"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { formatCount } from "@/lib/social/format";
import { profilePath } from "@/lib/social/links";
import type { ProfileStats } from "@/lib/social/profile/stats";

/**
 * Cifrele reale ale profilului propriu pe /account (GET /api/users/me/stats —
 * același modul ca /u/<username>) + link spre profilul public. Pagina de cont e
 * încă hard-dark, deci textele folosesc variante albe.
 */
export function AccountSocialSummary({ username }: { username: string | null }) {
  const t = useTranslations("social.profile");
  const locale = useLocale();
  const [stats, setStats] = useState<ProfileStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me/stats", { cache: "no-store", credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { stats?: ProfileStats } | null) => {
        if (!cancelled && d?.stats) setStats(d.stats);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const value = (n: number | undefined) => (n === undefined ? "–" : formatCount(n, locale));
  const items = [
    { key: "following", label: t("following"), n: stats?.following },
    { key: "followers", label: t("followers"), n: stats?.followers },
    { key: "likes", label: t("likes"), n: stats?.likes },
  ];

  return (
    <>
      {username ? (
        <Link
          href={profilePath(username)}
          className="mb-4 inline-flex min-h-11 items-center text-sm font-semibold text-white/80 underline-offset-2 hover:underline"
        >
          {t("viewPublicProfile")}
        </Link>
      ) : null}
      <div className="mb-6 flex w-full items-center justify-center gap-8 px-8">
        {items.map((item) => {
          const body = (
            <>
              <p className="text-lg font-black">{value(item.n)}</p>
              <p className="text-xs text-white/60">{item.label}</p>
            </>
          );
          return username && item.key !== "likes" ? (
            <Link key={item.key} href={profilePath(username)} className="min-h-11 text-center">
              {body}
            </Link>
          ) : (
            <div key={item.key} className="text-center">
              {body}
            </div>
          );
        })}
      </div>
    </>
  );
}
