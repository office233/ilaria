import { Link } from "@/lib/i18n/navigation";

/**
 * Swypik brand mark — violet upward arrow + wordmark.
 * Used in TopBar. Culorile vin din tokeni (se adaptează light/dark).
 */
export default function Logo({
  href = "/",
  showText = true,
  size = 20,
}: {
  href?: string | null;
  showText?: boolean;
  size?: number;
}) {
  const content = (
    <span className="inline-flex items-center gap-1.5">
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="swypik-arrow-grad" x1="0" y1="24" x2="24" y2="0">
            <stop offset="0%" style={{ stopColor: "rgb(var(--brand))" }} />
            <stop offset="100%" style={{ stopColor: "rgb(var(--brand-hover))" }} />
          </linearGradient>
        </defs>
        <path
          d="M12 3 L20 13 H15 V21 H9 V13 H4 Z"
          fill="url(#swypik-arrow-grad)"
          style={{ stroke: "rgb(var(--brand))" }}
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      {showText && <span className="text-lg font-bold tracking-tight text-fg">Swypik</span>}
    </span>
  );
  if (!href) return content;
  return (
    <Link href={href} aria-label="Swypik" className="inline-flex items-center">
      {content}
    </Link>
  );
}
