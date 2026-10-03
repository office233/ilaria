import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";

/** Card KPI compact: încape în 2 coloane la 360px (valoarea se trunchiază, nu iese din card). */
export function KpiCard({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <Card padding="sm" className="min-w-0">
      <div className="flex items-center gap-2 text-muted">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <p className="truncate text-xs font-medium">{label}</p>
      </div>
      <p className="mt-2 truncate text-lg font-bold tabular-nums text-fg sm:text-2xl" title={value}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-xs text-subtle">{hint}</p> : null}
    </Card>
  );
}
