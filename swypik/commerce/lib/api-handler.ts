/**
 * Common API route error-handling wrapper.
 *
 * Usage:
 *   import { withErrorHandling } from "@/lib/api-handler";
 *   export const GET = withErrorHandling(async function GET(req) { ... });
 *
 * Postgres invalid-input errors (22P02 & co.) become 400 { error: "invalid_input" }.
 * Catches any other uncaught exception thrown by the handler, logs it with the
 * structured logger, and returns a consistent 500 JSON body:
 *   { error: "internal_error" }
 *
 * Does NOT alter the handler's own responses (4xx/5xx returned explicitly
 * by the route pass through untouched).
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { isPgInvalidInputError } from "@/lib/validation/params";

// Matches any Next.js App Router route handler signature:
// (request?, context?) => Response | Promise<Response>
type RouteHandler<Args extends unknown[]> = (
  ...args: Args
) => Response | Promise<Response>;

export function withErrorHandling<Args extends unknown[]>(
  handler: RouteHandler<Args>,
): RouteHandler<Args> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      // Plasă de siguranță: parametru invalid ajuns în SQL (uuid/număr/dată) = eroare
      // de client, nu 500. Rutele ar trebui oricum să valideze cu zod înainte.
      if (isPgInvalidInputError(err)) {
        return NextResponse.json({ error: "invalid_input" }, { status: 400 });
      }
      const req = args[0] as { url?: string; method?: string } | undefined;
      let route: string | undefined;
      try {
        route = req?.url ? new URL(req.url).pathname : undefined;
      } catch {
        route = req?.url;
      }
      logger.error(
        { err, route, method: req?.method },
        "unhandled API route error",
      );
      if (process.env.SENTRY_DSN) {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureException(err, { tags: { route, method: req?.method } });
      }
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  };
}
