/**
 * Încărcarea modulelor opționale de carduri (live, news) FĂRĂ import static:
 * dacă `lib/<modul>/feed-items.ts` nu există încă (modul în lucru / șters),
 * importul eșuează la runtime și tipul respectiv e sărit — build-ul nu cade.
 * Webpack creează un context din `lib/<x>/feed-items` și include doar
 * fișierele care există la build.
 */
import { logger } from "@/lib/logger";

export type OptionalModule = "live" | "news";

const EXPORT_NAME: Record<OptionalModule, string> = {
  live: "getLiveFeedItems",
  news: "getNewsFeedItems",
};

type Producer = (opts: { limit: number }) => Promise<unknown>;

async function importModule(name: OptionalModule): Promise<unknown> {
  return import(`../../${name}/feed-items`);
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
