import { Target } from "lucide-react";
import { cn } from "@/lib/ui/cn";

type Props = {
  image: string | null;
  alt: string;
  className?: string;
};

/**
 * Imaginea produsului misiunii sau un placeholder cu iconiță. <img> simplu:
 * imaginile de catalog vin de pe gazde arbitrare (nu sunt în allowlist-ul next/image).
 */
export function MissionThumb({ image, alt, className }: Props) {
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-control border border-subtle bg-surface-2 text-subtle",
        className,
      )}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt={alt} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <Target className="h-6 w-6" aria-hidden />
      )}
    </div>
  );
}
