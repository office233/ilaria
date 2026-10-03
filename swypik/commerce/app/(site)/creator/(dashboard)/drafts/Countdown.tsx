"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

export default function Countdown({ target }: { target: string }) {
  const t = useTranslations("creatorCountdown");
  const locale = useLocale();
  const targetMs = new Date(target).getTime();
  const fmt = new Date(target).toLocaleString(locale);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (now === null) {
    return (
      <span suppressHydrationWarning>
        {t("sePublica")} · {fmt}
      </span>
    );
  }

  const diff = Math.max(0, targetMs - now);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return (
    <span>
      {t("sePublicaIn", { h, m })} · {fmt}
    </span>
  );
}
