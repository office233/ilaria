import { Link } from "@/lib/i18n/navigation";
import { cn } from "@/lib/ui/cn";

const SIZE_CLASS = { sm: "text-lg", md: "text-xl", lg: "text-3xl" } as const;

/** Wordmark „SWYPIK MOVIES" — doar tokeni (gradientul de brand), fără culori literale. */
export default function MoviesBrand({ href = "/movies", size = "md" }: { href?: string; size?: keyof typeof SIZE_CLASS }) {
  return (
    <Link
      href={href}
      aria-label="Swypik Movies"
      className={cn("inline-flex min-h-11 select-none items-center gap-1.5 font-black leading-none tracking-tight", SIZE_CLASS[size])}
    >
      <span className="text-fg">SWYPIK</span>
      <span className="bg-brand-gradient bg-clip-text tracking-wider text-transparent">MOVIES</span>
    </Link>
  );
}
