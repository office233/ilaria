/**
 * Regulile de vizibilitate ale feed-ului — un singur loc, folosit de toate
 * sursele de candidați și de hidratare (defensiv: un snapshot vechi nu poate
 * scoate la suprafață un clip ascuns între timp).
 *
 * Clip vizibil = ready + public + neascuns + `effective_label = 'safe'`
 * (poarta de moderare, 20260926_0012: pending/rejected/adult/blocked nu apar)
 * + creator activ (conturile de test suspendate la curățare, 20260926_0005).
 *
 * Produsul legat NU mai condiționează clipul (bug după curățarea datelor: un
 * produs arhivat ascundea tot clipul). Produsul se atașează doar dacă e
 * eligibil (PRODUCT_ATTACH_SQL); altfel clipul apare fără card de produs.
 */
import { isEnabled } from "@/lib/feature-flags";
import { notBlockedSql } from "@/lib/social/blocks";
import { FEED_ELIGIBLE_PRODUCT_SQL } from "@/lib/video/product-eligibility";

/** Titluri de produs care nu apar niciodată ca atașament în feed (politică de conținut). */
const COMMERCE_BLOCKLIST_RE = [
  "jock[ -]?strap", "g[ -]?strings?", "thongs?", "open[ -]?butt", "see[ -]?through", "transparent",
  "lingerie", "panties", "panty", "underwear", "underpants", "briefs", "bralette", "bikini", "bodysuit",
  "corset", "sexy", "erotic", "adult", "fetish", "bdsm", "anal", "vibrator", "dildo", "condom", "nipple",
  "penis", "vagina", "sissy", "chastity",
].join("|");

/** Categorii ascunse implicit din For You (rămân vizibile în categorie/profil/following). */
const SOFT_BLOCK_RE = [
  "underwear", "underpants", "panties", "panty", "lingerie", "shapewear", "body[ -]?shaper", "bodysuit",
  "bras?", "bralette", "briefs", "menstrual panties", "girdle", "corset", "bikini", "swimwear",
  "nightdress", "sleepwear", "slip sleep",
].join("|");

/** Condiții pe alias-ul `v` (videos). Fără input utilizator. */
export function visibleVideoSql(): string {
  const movies = isEnabled("movies")
    ? `NOT EXISTS (
         SELECT 1 FROM movie_episodes me JOIN movie_series ms ON ms.id = me.series_id
          WHERE me.video_id = v.id
            AND NOT (ms.status = 'published' AND me.status = 'published' AND me.episode_number <= ms.free_episodes))`
    : `NOT EXISTS (SELECT 1 FROM movie_episodes me WHERE me.video_id = v.id)`;
  return `v.status = 'ready'
    AND v.is_hidden = false
    AND v.visibility = 'public'
    AND v.effective_label = 'safe'
    AND NOT EXISTS (SELECT 1 FROM users cu WHERE cu.id = v.creator_id AND COALESCE(cu.status, 'active') <> 'active')
    AND ${movies}`;
}

/**
 * Exclude, pentru viewer, clipurile ascunse explicit („Nu mă interesează”) și
 * clipurile creatorilor cu care există o blocare în oricare sens (`user_blocks`).
 * `$param` = user id.
 */
export function notHiddenByViewerSql(userParam: string | null): string {
  return userParam
    ? `AND NOT EXISTS (SELECT 1 FROM user_hidden_videos uhv WHERE uhv.user_id = ${userParam}::uuid AND uhv.video_id = v.id)
       AND ${notBlockedSql("v.creator_id", userParam)}`
    : "";
}

/**
 * Subtitrările clipului sunt afișate (alias `v`). Creatorul le poate opri din
 * wizard (`metadata.captions_enabled = false`); clipurile vechi, fără cheie,
 * rămân cu subtitrările automate vizibile.
 */
export const CAPTIONS_ENABLED_SQL = `COALESCE(v.metadata->>'captions_enabled', 'true') <> 'false'`;

/** Condițiile de atașare a produsului, pe alias-ul `p` (marketplace_products). */
export function productAttachSql(opts: { softBlock: boolean }): string {
  return `${FEED_ELIGIBLE_PRODUCT_SQL}
    AND COALESCE(p.title, '') !~* '${COMMERCE_BLOCKLIST_RE}'
    ${opts.softBlock ? `AND COALESCE(p.title, '') !~* '${SOFT_BLOCK_RE}' AND COALESCE(p.taxonomy_node_slug, '') !~* '(underwear|lingerie|swimwear)'` : ""}`;
}

/** Id-ul produsului legat de clip: video_product_links (prioritar) sau product_refs[0]. */
export const LINKED_PRODUCT_ID_SQL = `COALESCE(
  (SELECT vpl.product_id FROM video_product_links vpl WHERE vpl.video_id = v.id
    ORDER BY CASE vpl.placement WHEN 'pinned' THEN 0 WHEN 'overlay' THEN 1 WHEN 'chapter' THEN 2 ELSE 3 END,
             vpl.sort_order ASC, vpl.created_at DESC
    LIMIT 1),
  CASE WHEN COALESCE(v.product_refs->0->>'product_id', v.product_refs->>0)
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN COALESCE(v.product_refs->0->>'product_id', v.product_refs->>0)::uuid END)`;
