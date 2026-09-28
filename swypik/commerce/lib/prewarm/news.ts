/**
 * Prima pagină a listei de știri (toate + fiecare categorie) ținută caldă în
 * Redis: cererile `/api/news` fără offset o citesc de acolo în loc să lovească
 * Postgres. Reîmprospătată de cron-ul `prewarm-catalogs` (15 min), imediat după
 * o rulare `news-pipeline` care a publicat ceva și la moderarea unui articol
 * (invalidare) — deci o retragere nu rămâne vizibilă până la următorul cron.
 */
import { listArticles, type NewsArticleListItem } from "@/lib/news/repository";
import { NEWS_CATEGORY_SLUGS, type NewsCategorySlug } from "@/lib/news/categories";
import { NEWS_PAGE_SIZE } from "@/lib/news/config";
import { logger } from "@/lib/logger";
import { deleteWarm, isStale, readWarm, writeWarm } from "./warm-store";

const FILTERS: ReadonlyArray<NewsCategorySlug | null> = [null, ...NEWS_CATEGORY_SLUGS];

export function newsWarmKey(category: NewsCategorySlug | null): string {
    return `news:list:${category ?? "all"}`;
}

/** Rândurile primei pagini (+1 pentru `hasMore`), exact ca interogarea directă. */
function loadFirstPage(category: NewsCategorySlug | null): Promise<NewsArticleListItem[]> {
    return listArticles({ category, limit: NEWS_PAGE_SIZE + 1, offset: 0 });
}

export async function refreshNewsLists(): Promise<number> {
    let written = 0;
    for (const category of FILTERS) {
        await writeWarm(newsWarmKey(category), await loadFirstPage(category));
        written += 1;
    }
    return written;
}

/** Calea cererii: copia caldă dacă e proaspătă, altfel Postgres (și o re-scrie). */
export async function getNewsFirstPage(category: NewsCategorySlug | null): Promise<NewsArticleListItem[]> {
    const key = newsWarmKey(category);
    const entry = await readWarm<NewsArticleListItem[]>(key);
    if (entry && !isStale(entry)) return entry.data;
    const rows = await loadFirstPage(category);
    await writeWarm(key, rows).catch((err: unknown) => logger.warn({ err }, "[prewarm] news write failed"));
    return rows;
}

/**
 * După moderare: șterge copiile, următoarea cerere citește din Postgres. Celelalte
 * replici nu mai folosesc copia locală, pentru că Redis răspunde „lipsă”.
 */
export async function invalidateNewsLists(): Promise<void> {
    await deleteWarm(FILTERS.map(newsWarmKey));
}
