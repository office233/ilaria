/**
 * Structured logger — pino
 *
 * REQUIRES: `npm install pino pino-pretty`
 *   - pino:        production JSON logger (small, fast, Next.js-friendly)
 *   - pino-pretty: dev-only colorized output (devDependency-only is fine)
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.error({ err, route: "/api/checkout", request_id }, "checkout failed");
 *   logger.warn({ productId }, "product not found");
 *
 *   // Per-route child:
 *   const log = logger.child({ route: "/api/webhooks/stripe", service: "next-web" });
 *   log.error({ err }, "signature verification failed");
 *
 * Field conventions (see docs/OBSERVABILITY.md):
 *   service, request_id, actor_id|session_id, route|job_type,
 *   video_id, product_id, checkout_id, environment, error_code
 *
 * NEVER log: secrets, raw Stripe payloads, full Authorization headers,
 *            full upload paths, customer payment data.
 */

import pino, { type Logger, type LoggerOptions } from "pino";

const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

const baseOptions: LoggerOptions = {
  level,
  base: {
    service: "next-web",
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  },
  // Standard time + scrub a few common secret-ish keys.
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "*.password",
      "*.secret",
      "*.token",
      "*.stripeSignature",
      "payment_method",
      "card",
    ],
    censor: "[REDACTED]",
  },
};

const devTransport: LoggerOptions["transport"] = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "SYS:HH:MM:ss.l",
    ignore: "pid,hostname,service,environment",
  },
};

/**
 * pino-pretty rulează într-un worker thread. Sub `next dev` (webpack) worker-ul
 * nu-și găsește chunk-urile ("Cannot find module vendor-chunks/lib/worker.js")
 * și moare cu "the worker has exited", corupând .next la fiecare log.
 * De aceea transportul pretty se activează doar explicit, cu PINO_PRETTY=1
 * (util în scripturi/workeri Node rulați direct, nu în serverul Next).
 */
const usePretty = !isProd && process.env.PINO_PRETTY === "1";

export const logger: Logger = usePretty
  ? pino({ ...baseOptions, transport: devTransport })
  : pino(baseOptions);

export default logger;
