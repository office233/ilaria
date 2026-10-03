"use client";

import Link from "next/link";
import { Trophy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import type { MissionBadge as MissionBadgeData } from "@/lib/missions/feed-badge";

/** Insigna „Misiune” pe un clip înscris la o misiune RON (câștigător / participă și tu). */
export default function MissionBadge({ mission }: { mission: MissionBadgeData }) {
  const t = useTranslations("explore");
  const locale = useLocale() as Locale;
  const prize = formatMoneyCents(mission.prizeCents, mission.currency, locale);
  const label = mission.winner ? t("missionWinner") : mission.open ? t("missionJoin") : t("missionEntry");
  return (
    <Link
      href={`/missions/${encodeURIComponent(mission.slug)}`}
      className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full bg-black/45 px-3 text-white ring-1 ring-white/15 backdrop-blur-md"
    >
      <Trophy aria-hidden className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 truncate text-xs font-semibold">
        {label} · {mission.title}
      </span>
      <span className="shrink-0 text-xs font-bold tabular-nums">{prize}</span>
    </Link>
  );
}
