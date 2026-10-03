import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/ui/cn";

export type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Acțiune principală (de obicei un <Button>). */
  action?: ReactNode;
  className?: string;
};

/** Stare goală: iconiță, titlu, descriere, acțiune. Toate textele vin deja traduse. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon ? (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-subtle">
          <Icon className="h-7 w-7" aria-hidden />
        </span>
      ) : null}
      <p className="text-base font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
