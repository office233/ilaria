"use client";

import { CalendarClock, CircleSlash, Loader2, Radio, WifiOff } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Link } from "@/lib/i18n/navigation";

type Props =
  | { kind: "unconfigured" | "ended" | "connecting" }
  | { kind: "scheduled"; scheduledAt: string | null }
  | { kind: "error"; onRetry: () => void };

/** Stările oneste ale ecranului Live, fără video fals. */
export function LiveStateCard(props: Props) {
  const t = useTranslations("live.state");
  const format = useFormatter();

  if (props.kind === "connecting") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        {t("connecting")}
      </div>
    );
  }

  const content = {
    unconfigured: { icon: CircleSlash, title: t("unconfiguredTitle"), description: t("unconfiguredDescription") },
    ended: { icon: Radio, title: t("endedTitle"), description: t("endedDescription") },
    error: { icon: WifiOff, title: t("errorTitle"), description: t("errorDescription") },
    scheduled: {
      icon: CalendarClock,
      title: t("scheduledTitle"),
      description:
        props.kind === "scheduled" && props.scheduledAt
          ? t("scheduledAt", { when: format.dateTime(new Date(props.scheduledAt), { dateStyle: "medium", timeStyle: "short" }) })
          : t("scheduledDescription"),
    },
  }[props.kind];

  const action =
    props.kind === "error" ? (
      <Button onClick={props.onRetry}>{t("retry")}</Button>
    ) : props.kind === "ended" || props.kind === "unconfigured" ? (
      <Button asChild variant="secondary">
        <Link href="/live">{t("browseLive")}</Link>
      </Button>
    ) : undefined;

  return (
    <div className="flex h-full items-center justify-center px-gutter">
      <EmptyState icon={content.icon} title={content.title} description={content.description} action={action} />
    </div>
  );
}
