import { Link } from "@/lib/i18n/navigation";
import { cn } from "@/lib/ui/cn";

/** Wordmark „SWYPIK MUSIC" — doar tokeni (gradientul de brand). */
export default function MusicBrand({ href = "/music", size = "md" }: { href?: string; size?: "md" | "lg" }) {
  return (
    <Link
      href={href}
      aria-label="Swypik Music"
      className={cn("inline-flex min-h-11 items-center gap-1.5 font-black leading-none tracking-tight", size === "lg" ? "text-3xl" : "text-lg")}
    >
      <span className="text-fg">SWYPIK</span>
      <span className="bg-brand-gradient bg-clip-text text-transparent">MUSIC</span>
    </Link>
  );
}
