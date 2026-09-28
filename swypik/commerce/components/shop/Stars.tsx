import { Star } from "lucide-react";
import { cn } from "@/lib/ui/cn";

type Props = {
  value: number;
  /** Text accesibil deja tradus (ex. „4,5 din 5 stele”). */
  label: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const SIZES = { sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-5 w-5" } as const;

/** Stele de rating (afișare). Culori din tokeni: plin = warning, gol = border. */
export function Stars({ value, label, size = "md", className }: Props) {
  const v = Math.max(0, Math.min(5, Number.isFinite(value) ? value : 0));
  const rounded = Math.round(v);
  return (
    <span role="img" aria-label={label} className={cn("inline-flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          aria-hidden
          className={cn(SIZES[size], i <= rounded ? "fill-warning text-warning" : "text-fg-subtle/40")}
        />
      ))}
    </span>
  );
}
