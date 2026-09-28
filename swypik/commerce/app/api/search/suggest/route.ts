/**
 * Search Suggestions — PostgreSQL-powered autocomplete.
 * Supports: products, categories, #hashtags, @users.
 */
import { NextResponse } from "next/server";
import { moderateText } from "@/lib/moderation/moderateText";
import { searchCreators, searchHashtags, searchProducts } from "@/lib/search/query";

import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";
export const dynamic = "force-dynamic";

type Suggestion = { label: string; type: "categorie" | "produs" | "hashtag" | "user"; href?: string; count?: number };

// Cache per replică (acceptabil: date publice, TTL 5 min, fără invalidare).
// Mărginit — înainte creștea nelimitat cu fiecare interogare distinctă.
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const SOFT_COMMERCE_QUERY_RE = /\b(sexy|adult|erotic|fetish|bdsm|underwear|underpants|panties|panty|lingerie|shapewear|bodysuit|bra|bras|bralette|briefs|bikini|swimwear|nightdress|sleepwear|corset|socks?)\b/i;
const SOFT_COMMERCE_TITLE_RE = /\b(sexy|adult|erotic|fetish|bdsm|underwear|underpants|panties|panty|lingerie|shapewear|bodysuit|bra|bras|bralette|briefs|bikini|swimwear|nightdress|sleepwear|corset)\b/i;
const MARKETPLACE_SPAM_TITLE_RE = /\b(amazon|hot[ -]?selling|luxury|wholesale|factory direct|dropship)\b/i;

function suggestionLabel(title: string | null) {
  const cleaned = String(title || "").replace(/\s+/g, " ").trim();
  return cleaned.length > 50 ? `${cleaned.slice(0, 50)}...` : cleaned;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = String(url.searchParams.get("q") || "").trim();
    const __mod = moderateText(typeof q === "string" ? q : "", "search");
    if (__mod.action === "reject") {
      return NextResponse.json({ suggestions: [], blocked: true }, { status: 200 });
    }
    const rawLimit = Number(url.searchParams.get("limit") || 8);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 12)) : 8;

    if (q.length < 2) return applyCachePolicy(NextResponse.json({ ok: true, suggestions: [] }), "search/suggest", req);

    const cacheKey = `suggest_${q}_${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return applyCachePolicy(NextResponse.json(cached.data), "search/suggest", req);

    const suggestions: Suggestion[] = [];
    const seenLabels = new Set<string>();

    const isHashtag = q.startsWith("#");
    const isUser = q.startsWith("@");
    const cleaned = q.replace(/^[#@]+/, "");

    // Prioritize specialized queries
    if (isHashtag && cleaned.length >= 1) {
      const tags = await searchHashtags(cleaned, { limit: 6 }).catch(() => []);
      for (const t of tags) {
        suggestions.push({ label: `#${t.tag}`, type: "hashtag", href: `/hashtag/${encodeURIComponent(t.tag)}`, count: t.video_count });
      }
    } else if (isUser && cleaned.length >= 1) {
      const creators = await searchCreators(cleaned, { limit: 6 }).catch(() => []);
      for (const c of creators) {
        const uname = c.username || "user";
        suggestions.push({ label: `@${uname}`, type: "user", href: `/u/${uname}` });
      }
    } else {
      // Mixed: hashtags + creators + products
      const [tags, creators] = await Promise.all([
        searchHashtags(cleaned, { limit: 2 }).catch(() => []),
        searchCreators(cleaned, { limit: 2 }).catch(() => []),
      ]);
      for (const t of tags) {
        suggestions.push({ label: `#${t.tag}`, type: "hashtag", href: `/hashtag/${encodeURIComponent(t.tag)}`, count: t.video_count });
        seenLabels.add(`#${t.tag}`);
      }
      for (const c of creators) {
        const uname = c.username || "user";
        if (!seenLabels.has(`@${uname}`)) {
          suggestions.push({ label: `@${uname}`, type: "user", href: `/u/${uname}` });
          seenLabels.add(`@${uname}`);
        }
      }

      const allowSoftCommerce = SOFT_COMMERCE_QUERY_RE.test(cleaned || q);
      const products = await searchProducts(cleaned || q, { limit: 20 }).catch(() => []);
      for (const p of products) {
        if (!allowSoftCommerce && SOFT_COMMERCE_TITLE_RE.test(p.title || "")) continue;
        if (MARKETPLACE_SPAM_TITLE_RE.test(p.title || "")) continue;
        if (suggestions.length >= 4 && Number(p.rank || 0) < 1.2) continue;
        const label = suggestionLabel(p.title);
        if (!label) continue;
        if (suggestions.length < limit && !seenLabels.has(label)) {
          suggestions.push({ label, type: "produs" });
          seenLabels.add(label);
        }
      }
    }

    const responseData = { ok: true, q, suggestions: suggestions.slice(0, limit) };
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, { data: responseData, ts: Date.now() });
    return applyCachePolicy(NextResponse.json(responseData), "search/suggest", req);
  } catch (error: any) {
    logger.error({ err: error }, "[Search Suggest]");
    return NextResponse.json({ ok: false, error: "A apărut o eroare la căutare.", suggestions: [] }, { status: 500 });
  }
}
