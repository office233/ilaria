import Link from "next/link";
import { SearchX } from "lucide-react";
import ro from "@/messages/ro.json";
import { interFont } from "@/components/layout/fonts";

// 404 pentru URL-uri care nu intră nici în [locale], nici în (site). Root
// layout-ul e pass-through, deci pagina își randează singură <html>/<body>.
// Nu există provider next-intl aici (și nici locale în URL) → textele vin
// direct din limba implicită (ro); tokenurile vin din globals.css.
const t = ro.errorPage;

export default function NotFound() {
  return (
    <html lang="ro" className={interFont.variable}>
      <body className="bg-canvas font-sans text-fg antialiased">
        <main className="flex min-h-dvh items-center px-4 py-16">
          <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
            <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
              <SearchX className="h-8 w-8" aria-hidden />
            </span>
            <p className="text-sm font-semibold uppercase tracking-wide text-brand">404</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.notFoundTitle}</h1>
            <p className="mt-2 text-sm text-muted">{t.notFoundBody}</p>
            <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <Link
                className="inline-flex h-11 items-center justify-center rounded-control bg-brand px-5 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
                href="/"
              >
                {t.backToFeed}
              </Link>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-control border border-subtle bg-surface px-5 text-sm font-semibold text-fg hover:bg-surface-2"
                href="/search"
              >
                {t.searchProducts}
              </Link>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
