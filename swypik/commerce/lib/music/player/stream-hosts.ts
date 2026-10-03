/**
 * Helperi puri pentru URL-urile de stream: lista de candidați (principal + alternative)
 * și origin-urile pentru preconnect / dns-prefetch, cu deduplicare și limită LRU.
 */
import { STREAM_MAX_CANDIDATES } from "./config";

type StreamSource = { streamUrl?: string; streamUrlFallbacks?: string[] };

function parseUrl(raw: string): URL | null {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

/**
 * [streamUrl, ...streamUrlFallbacks] fără duplicate; alternativele sunt acceptate doar pe https
 * (pagina e servită pe https — un flux http ar fi blocat ca mixed content).
 */
export function streamCandidates(source: StreamSource, max: number = STREAM_MAX_CANDIDATES): string[] {
    const out: string[] = [];
    const primary = source.streamUrl?.trim();
    if (primary && parseUrl(primary)) out.push(primary);
    for (const raw of source.streamUrlFallbacks ?? []) {
        const url = raw.trim();
        const parsed = parseUrl(url);
        if (!parsed || parsed.protocol !== "https:") continue;
        if (!out.includes(url)) out.push(url);
    }
    return out.slice(0, Math.max(0, max));
}

/** Origin-urile http(s) distincte ale URL-urilor date, excluzând origin-ul paginii. */
export function streamOrigins(urls: readonly string[], pageOrigin?: string): string[] {
    const out: string[] = [];
    for (const raw of urls) {
        const parsed = parseUrl(raw);
        if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) continue;
        if (parsed.origin === pageOrigin) continue;
        if (!out.includes(parsed.origin)) out.push(parsed.origin);
    }
    return out;
}

export type PreconnectPlan = {
    /** Lista nouă, cel mai recent folosit la final. */
    next: string[];
    /** Origin-uri noi pentru care trebuie create tag-uri `<link>`. */
    add: string[];
    /** Origin-uri evacuate (cele mai vechi) ale căror tag-uri trebuie scoase. */
    remove: string[];
};

/**
 * Actualizare LRU a setului de origin-uri preconectate: cele atinse din nou trec la final,
 * cele noi se adaugă, iar peste `max` se scot cele mai vechi.
 */
export function planPreconnect(current: readonly string[], origins: readonly string[], max: number): PreconnectPlan {
    const limit = Math.max(0, max);
    const wanted = limit === 0 ? [] : [...new Set(origins)].slice(-limit);
    const kept = current.filter((o) => !wanted.includes(o));
    const add = wanted.filter((o) => !current.includes(o));
    const merged = [...kept, ...wanted];
    const overflow = Math.max(0, merged.length - limit);
    const evicted = merged.slice(0, overflow);
    return {
        next: merged.slice(overflow),
        add: add.filter((o) => !evicted.includes(o)),
        remove: evicted.filter((o) => current.includes(o)),
    };
}
