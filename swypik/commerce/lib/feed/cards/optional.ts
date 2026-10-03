/**
 * Încărcarea lazy a modulelor de carduri live/news.
 *
 * Importurile sunt declarate explicit, nu construite din string-uri dinamice:
 * bundler-ul poate valida și împărți chunk-urile determinist, fără context
 * imports fragile sau warnings Vite/webpack.
 */
import { logger } from "@/lib/logger";

export type OptionalModule = "live" | "news";

const EXPORT_NAME: Record<OptionalModule, string> = {
  live: "getLiveFeedItems",
  news: "getNewsFeedItems",
};

type Producer = (opts: { limit: number }) => Promise<unknown>;

async function importModule(name: OptionalModule): Promise<unknown> {
  switch (name) {
    case "live":
      return import("@/lib/live/feed-items");
    case "news":
      return import("@/lib/news/feed-items");
  }
}

/** Producătorul modulului, sau null dacă modulul/exportul lipsește. */
export async function loadOptionalProducer(
  name: OptionalModule,
  load: (name: OptionalModule) => Promise<unknown> = importModule,
): Promise<Producer | null> {
  try {
    const mod = await load(name);
    const fn = typeof mod === "object" && mod !== null ? (mod as Record<string, unknown>)[EXPORT_NAME[name]] : undefined;
    return typeof fn === "function" ? (fn as Producer) : null;
  } catch (err) {
    logger.debug({ err, module: name }, "[feed/cards] optional module not available");
    return null;
  }
}
