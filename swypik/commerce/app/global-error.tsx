"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import ro from "@/messages/ro.json";
import "./globals.css";

// Boundary-ul global înlocuiește și root layout-ul: fără providers (next-intl,
// temă) → texte din limba implicită, tokenuri din globals.css.
const t = ro.errorPage;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ro">
      <body className="bg-canvas font-sans text-fg antialiased">
        <main className="flex min-h-dvh items-center px-4 py-16">
          <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
            <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
            <p className="mt-2 text-sm text-muted">{t.body}</p>
            {error.digest ? <p className="mt-2 text-xs text-subtle">{t.code.replace("{code}", error.digest)}</p> : null}
            <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => reset()}
                className="inline-flex h-11 items-center justify-center rounded-control bg-brand px-5 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
              >
                {t.retry}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- reload complet după o eroare globală */}
              <a
                href="/"
                className="inline-flex h-11 items-center justify-center rounded-control border border-subtle bg-surface px-5 text-sm font-semibold text-fg hover:bg-surface-2"
              >
                {t.home}
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
