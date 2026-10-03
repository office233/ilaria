import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Replica web (Node): verificare env + oprire grațioasă. Nu rulează în edge
  // (middleware) — acolo nu există process.on / process.exit.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNodeRuntime } = await import("./lib/runtime/boot");
    bootNodeRuntime();
  }

  if (!process.env.SENTRY_DSN) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
  });
}

export const onRequestError = Sentry.captureRequestError;
