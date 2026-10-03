"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";

/** Conținutul comun pentru error.tsx ([locale] și (site)): tokenuri + texte traduse. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errorPage");
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center bg-canvas px-gutter py-16 text-fg">
      <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
        <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="h-8 w-8" aria-hidden />
        </span>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("body")}</p>
        {error.digest ? <p className="mt-2 text-xs text-subtle">{t("code", { code: error.digest })}</p> : null}
        <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={() => reset()}>{t("retry")}</Button>
          <Button asChild variant="secondary">
            <Link href="/">{t("home")}</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
