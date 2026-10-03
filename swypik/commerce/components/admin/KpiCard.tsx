import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/ui/cn";

export type KpiTone = "neutral" | "warning" | "danger" | "success";

const TONE: Record<KpiTone, string> = {
  neutral: "bg-surface-2 text-muted",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
};

/** Card de indicator: valoare mare + etichetă; link opțional către coada relevantă. */
export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: KpiTone;
  href?: string;
}) {
  const body = (
    <>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", TONE[tone])}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-muted">{label}</span>
        <span className="block truncate text-2xl font-bold tabular-nums text-fg">{value}</span>
        {hint ? <span className="block truncate text-xs text-subtle">{hint}</span> : null}
      </span>
    </>
  );
  const cls = "flex min-h-[88px] items-center gap-3 rounded-card border border-subtle bg-surface p-4";
  return href ? (
    <Link href={href} className={cn(cls, "transition-shadow hover:shadow-elev-2")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
