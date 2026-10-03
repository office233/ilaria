/**
 * Feed universal — inima Swypik.
 *
 * GET /api/feed/universal?vertical=eats&city=Bucuresti&country=RO&limit=10&page=1
 *
 * Regula produsului: user-ul NU caută — feed-ul îi propune. Această rută
 * livrează clipuri + entitatea vandabilă atașată (produs/anunț/meniu/cazare),
 * cu acțiunea contextuală derivată din modul de tranzacție al verticalei.
 *
 *   • fără ?vertical  → mix din toate verticalele live (ponderat context)
 *   • cu   ?vertical  → doar clipurile verticalei respective
 *
 * Context automat: ora zilei influențează ponderile (12-14 → eats boost,
 * 18-22 → shop/reels boost). Locația filtrează verticalele localOnly.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import {
    getVertical,
    liveVerticals,
    verticalForTaxonomy,
    ACTION_KEY,
} from "@/lib/verticals/catalog";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";
import { notHiddenByViewerSql, visibleVideoSql } from "@/lib/feed/visibility";
import { getOptionalSocialUserId } from "@/lib/social/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Acceptă orice variantă de UUID (constantă de cod, nu input de utilizator). */
const PRODUCT_REF_UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Ponderea fiecărui grup de verticale în mix, pe intervale orare. */
function contextWeights(hourLocal: number): Record<string, number> {
    // grupuri: shop, local, property, travel, services, mobility, work
    if (hourLocal >= 11 && hourLocal < 15) return { local: 3, shop: 1.5, property: 1, travel: 1, services: 1, mobility: 0.5, work: 0.5 };
    if (hourLocal >= 18 && hourLocal < 23) return { shop: 3, local: 2, travel: 1.5, property: 1, services: 0.7, mobility: 0.5, work: 0.3 };
    if (hourLocal >= 6 && hourLocal < 11) return { shop: 2, work: 1.5, services: 1.2, local: 1, property: 1, travel: 1, mobility: 0.7 };
    return { shop: 2, local: 1, property: 1, travel: 1.2, services: 0.8, mobility: 0.5, work: 0.3 };
}

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const verticalId = url.searchParams.get("vertical")?.trim() || null;
        const subSlug = url.searchParams.get("sub")?.trim() || null;
        const country = url.searchParams.get("country")?.trim().toUpperCase() || null;
        const city = url.searchParams.get("city")?.trim() || null;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 30);
        const page = Math.max(Number(url.searchParams.get("page")) || 1, 1);
        const offset = (page - 1) * limit;

        // Validare verticală (dacă e cerută explicit)
        let taxonomyRoots: string[] | null = null;
        if (verticalId) {
            const v = getVertical(verticalId);
            if (!v) {
                // Cod stabil; textul îl traduce clientul.
                return NextResponse.json({ success: false, error: "unknown_vertical" }, { status: 400 });
            }
            // Subcategoria restrânge la un nod copil (validat contra catalogului).
            if (subSlug && v.subcategories?.some((s) => s.slug === subSlug)) {
                taxonomyRoots = [`${v.taxonomyRoot}/${subSlug}`];
            } else {
                taxonomyRoots = [v.taxonomyRoot];
            }
        }

        // Regulile comune de vizibilitate (lib/feed/visibility): fără clipuri
        // ascunse/arhivate, de creatori suspendați, episoade de film blocate,
        // ascunse de viewer sau de la creatori cu care există o blocare.
        const viewerId = await getOptionalSocialUserId().catch(() => null);
        const params: unknown[] = [];
        const where: string[] = [
            visibleVideoSql(),
            "COALESCE(v.is_adult, false) = false",
            // Fără redare nu există clip (tile-uri rupte pe /v/*).
            "v.playback_url IS NOT NULL",
            "v.playback_url <> ''",
        ];
        if (viewerId) {
            params.push(viewerId);
            where.push(notHiddenByViewerSql(`$${params.length}`).replace(/^AND /, ""));
        }

        if (taxonomyRoots) {
            params.push(taxonomyRoots[0], taxonomyRoots[0] + "/%");
            where.push(`(p.taxonomy_node_slug = $${params.length - 1} OR p.taxonomy_node_slug LIKE $${params.length})`);
        }
        if (country) {
            params.push(country);
            // Anunțurile/entitățile locale au location_country; produsele globale trec mereu.
            where.push(`(p.location_country IS NULL OR p.location_country = $${params.length})`);
        }
        if (city) {
            params.push(city);
            where.push(`(p.location_city IS NULL OR p.location_city ILIKE $${params.length})`);
        }

        params.push(limit, offset);

        // Clipuri cu prima entitate vandabilă atașată (product_refs[0]).
        const { rows } = await dbQuery(
            `SELECT
          v.id            AS video_id,
          v.slug          AS video_slug,
          v.title         AS video_title,
          v.thumbnail_url,
          v.playback_url,
          v.duration_ms,
          v.like_count,
          v.comment_count,
          u.id            AS publisher_id,
          COALESCE(cp.display_name, cp.handle, u.display_name, u.username) AS publisher_name,
          COALESCE(cp.avatar_url, u.avatar_url) AS publisher_avatar,
          COALESCE(cp.verification_status = 'verified', u.is_verified, false) AS publisher_verified,
          p.id            AS entity_id,
          p.slug          AS entity_slug,
          p.title         AS entity_title,
          p.price_cents,
          p.currency,
          p.listing_type,
          p.taxonomy_node_slug,
          p.location_city,
          p.image_url     AS entity_image
        FROM videos v
        -- 2026-08-25: era JOIN pe tabela creators, care e goala, desi
        -- videos.creator_id are cheie straina catre users (vezi
        -- videos_creator_id_fkey). Fiind INNER JOIN, feed-ul verticalelor
        -- intorcea ZERO clipuri intotdeauna - paginile /v/[id] aratau la
        -- nesfarsit "fii primul care publica".
        JOIN users u ON u.id = v.creator_id
        LEFT JOIN creator_profiles cp ON cp.id = v.creator_profile_id
        LEFT JOIN video_rank_14d vr ON vr.video_id = v.id
        -- 2026-08-24 (audit perf): castul mp.id::text anula PK-ul uuid si
        -- forta scanare secventiala peste tot catalogul pentru FIECARE clip.
        -- Comparam uuid cu uuid (regexul e evaluat inaintea castului, deci
        -- product_refs malformate nu produc 22P02). Acelasi tipar ca in
        -- app/api/explore/feed/route.ts.
        LEFT JOIN marketplace_products p
          ON p.id = CASE
               WHEN COALESCE(v.product_refs->0->>'product_id', v.product_refs->>0) ~* '${PRODUCT_REF_UUID_RE}'
               THEN COALESCE(v.product_refs->0->>'product_id', v.product_refs->>0)::uuid
               ELSE NULL
             END
         AND p.status = 'active'
        WHERE ${where.join(" AND ")}
        -- 2026-08-24 (audit): feed-ul „inima Swypik" era pur cronologic. Acum:
        -- engagement real 14 zile (log-comprimat, ca în explore/feed) +
        -- prospețime (0..5, decade în 3 zile) + explorare mică — clipurile bune
        -- urcă, cele noi au șansă, ordinea nu e deterministă.
        ORDER BY
          (LN(GREATEST(COALESCE(vr.rank_score, 0), 0) + 1) * 4)
          + GREATEST(0, 5 - EXTRACT(EPOCH FROM (NOW() - COALESCE(v.published_at, v.created_at))) / (86400.0 * 3))
          + (random() * 4) DESC,
          v.published_at DESC NULLS LAST, v.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
        );

        // Decorare: acțiunea contextuală + accentul verticalei per item.
        const items = rows.map((r: any) => {
            const v = verticalForTaxonomy(r.taxonomy_node_slug) ?? getVertical("shop")!;
            return {
                video: {
                    id: r.video_id,
                    slug: r.video_slug,
                    title: r.video_title,
                    thumbnail_url: r.thumbnail_url,
                    playback_url: r.playback_url,
                    duration_ms: r.duration_ms,
                    likes: r.like_count,
                    comments: r.comment_count,
                },
                publisher: {
                    id: r.publisher_id,
                    name: r.publisher_name,
                    avatar: r.publisher_avatar,
                    verified: Boolean(r.publisher_verified),
                },
                entity: r.entity_id
                    ? {
                        id: r.entity_id,
                        slug: r.entity_slug,
                        title: r.entity_title,
                        price_cents: r.price_cents,
                        currency: r.currency,
                        listing_type: r.listing_type,
                        image: r.entity_image,
                        city: r.location_city,
                    }
                    : null,
                vertical: {
                    id: v.id,
                    emoji: v.emoji,
                    accent: v.accent,
                    mode: v.mode,
                    actionKey: ACTION_KEY[v.mode],
                },
            };
        });

        // Meta pentru bara de categorii: verticalele live, cu ponderea orei.
        const hour = Number(url.searchParams.get("hour")) || new Date().getUTCHours() + 2; // RO default
        const weights = contextWeights(((hour % 24) + 24) % 24);
        const rail = liveVerticals(1).map((v) => ({
            id: v.id,
            emoji: v.emoji,
            labelKey: v.labelKey,
            accent: v.accent,
            weight: weights[v.group] ?? 1,
        })).sort((a, b) => b.weight - a.weight);

        // Audiență „anonymous”: cu cookie de identitate răspunsul (filtrat per viewer) e `private, no-store`.
        return applyCachePolicy(
            NextResponse.json({ success: true, items, rail, page, hasMore: items.length === limit }),
            "feed/universal",
            req,
        );
    } catch (error: unknown) {
        logger.error({ err: error }, "[feed/universal] error");
        return NextResponse.json({ success: false, error: "feed_unavailable" }, { status: 500 });
    }
}
