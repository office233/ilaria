import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { LICENSE_LABEL_KEY, type PublicAttribution } from "@/lib/movies/license";


/**
 * Creditul cerut de licență (CC BY cere atribuire vizibilă, cu sursa).
 * Se afișează pe pagina titlului; textul de atribuire e stocat exact cum
 * l-a introdus adminul (nume proprii, nu se traduce).
 */
export default function Attribution({ attribution }: { attribution: PublicAttribution }) {
  const t = useTranslations("movies");
  return (
    <section aria-labelledby="movie-attribution" className="rounded-card border border-subtle bg-surface-2 p-4">
      <h2 id="movie-attribution" className="text-sm font-semibold text-fg">
        {t("attributionTitle")} · {t(LICENSE_LABEL_KEY[attribution.licenseType])}
      </h2>
      {attribution.text && <p className="mt-1 whitespace-pre-line text-sm text-muted">{attribution.text}</p>}
      {attribution.sourceUrl && (
        <a
          href={attribution.sourceUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand underline-offset-4 hover:underline"
        >
          {t("attributionSource")} <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      )}
    </section>
  );
}
