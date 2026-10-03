import { getLocale, getTranslations } from "next-intl/server";
import { Clock, Coins, Trophy, Users } from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/Badge";
import type { PublicMission } from "@/lib/missions/repo";
import { MissionThumb } from "./MissionThumb";
import { formatRon, remainingLabel } from "./format";

/** Card de listă pentru o misiune deschisă (/missions). */
export async function MissionCard({ mission }: { mission: PublicMission }) {
  const t = await getTranslations("missionsHub");
  const locale = await getLocale();
  const prize = formatRon(mission.prizeCents, locale);

  return (
    <Link
      href={`/missions/${mission.slug}`}
      className="block rounded-card border border-subtle bg-surface p-3 text-fg transition-shadow duration-base ease-out hover:shadow-elev-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <div className="flex gap-3">
        <MissionThumb
          image={mission.product?.image ?? null}
          alt={mission.product?.title ?? mission.title}
          className="h-20 w-20"
        />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-semibold leading-snug">{mission.title}</h2>
          {mission.brief ? <p className="mt-1 line-clamp-2 text-sm text-muted">{mission.brief}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="success">
              <Coins className="h-3 w-3" aria-hidden /> {t("prizePerWinner", { amount: prize })}
            </Badge>
            {mission.maxWinners ? (
              <Badge tone="brand">
                <Trophy className="h-3 w-3" aria-hidden /> {t("winnersCount", { count: mission.maxWinners })}
              </Badge>
            ) : null}
            <Badge>
              <Clock className="h-3 w-3" aria-hidden /> {remainingLabel(t, mission.endsAt)}
            </Badge>
            <Badge>
              <Users className="h-3 w-3" aria-hidden /> {t("submissionsCount", { count: mission.submissionsCount })}
            </Badge>
          </div>
        </div>
      </div>
    </Link>
  );
}
