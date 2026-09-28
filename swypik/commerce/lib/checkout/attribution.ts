import { dbQuery } from "@/lib/db";

export type CheckoutAttribution = {
  creatorId?: string;
  videoId?: string;
  creatorProductLinkId?: string;
};

export async function resolveCheckoutAttribution(
  productId: string,
  inputVideoId?: string | null,
): Promise<CheckoutAttribution> {
  const videoParams: unknown[] = [productId];
  const videoFilter = inputVideoId ? "AND vpl.video_id::text = $2" : "";
  if (inputVideoId) videoParams.push(inputVideoId);

  const videoResult = await dbQuery<{
    creator_id: string | null;
    video_id: string | null;
    creator_product_link_id: string | null;
  }>(
    `SELECT
       COALESCE(cpl.creator_id::text, v.creator_id::text) AS creator_id,
       vpl.video_id::text AS video_id,
       vpl.creator_product_link_id::text AS creator_product_link_id
     FROM video_product_links vpl
     JOIN videos v ON v.id = vpl.video_id
     LEFT JOIN creator_product_links cpl ON cpl.id = vpl.creator_product_link_id
     WHERE vpl.product_id = $1
       ${videoFilter}
     ORDER BY
       CASE WHEN vpl.placement = 'pinned' THEN 0 ELSE 1 END,
       vpl.sort_order ASC,
       vpl.created_at DESC
     LIMIT 1`,
    videoParams,
  );

  const video = videoResult.rows[0];
  if (video?.creator_id) {
    return {
      creatorId: video.creator_id,
      videoId: video.video_id || undefined,
      creatorProductLinkId: video.creator_product_link_id || undefined,
    };
  }

  // Creatorii își etichetează produsele la upload prin `videos.product_refs`
  // (nu prin video_product_links) — clipul din care a venit cumpărătorul
  // trebuie să primească atribuirea și atunci.
  if (inputVideoId) {
    const refResult = await dbQuery<{ creator_id: string | null; video_id: string }>(
      `SELECT v.creator_id::text AS creator_id, v.id::text AS video_id
         FROM videos v
        WHERE v.id::text = $2
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(v.product_refs, '[]'::jsonb)) e
             WHERE (jsonb_typeof(e) = 'object' AND e->>'product_id' = $1)
                OR (jsonb_typeof(e) = 'string' AND e #>> '{}' = $1)
          )
        LIMIT 1`,
      [productId, inputVideoId],
    );
    const ref = refResult.rows[0];
    if (ref?.creator_id) return { creatorId: ref.creator_id, videoId: ref.video_id };
  }

  const linkResult = await dbQuery<{
    creator_id: string;
    creator_product_link_id: string;
  }>(
    `SELECT creator_id::text AS creator_id, id::text AS creator_product_link_id
     FROM creator_product_links
     WHERE product_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [productId],
  );

  const link = linkResult.rows[0];
  if (!link) return {};
  return {
    creatorId: link.creator_id,
    creatorProductLinkId: link.creator_product_link_id,
  };
}
