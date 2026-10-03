import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { dbQuery } from "@/lib/db";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { labelVideo } from "@/lib/moderation/labelVideo";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";

export const dynamic = "force-dynamic";

const BATCH = 200;

async function authorize(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

type ProductRow = {
  id: string;
  title: string | null;
  description: string | null;
  category: string | null;
  canonical_category: string | null;
};

type VideoRow = {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
};

export async function POST(req: Request): Promise<Response> {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runCron("classify-pending", async () => {
    // --- Products ---
    const { rows: productRows } = await dbQuery<ProductRow>(
      `
      SELECT mp.id, mp.title, mp.description, mp.category, mp.canonical_category
        FROM marketplace_products mp
        JOIN product_safety_labels psl ON psl.product_id = mp.id
       WHERE psl.classifier_version = 'auto_pending'
          OR (psl.classifier_version IS DISTINCT FROM 'v2'
              AND psl.reviewed_by_human = FALSE)
       ORDER BY psl.classified_at NULLS FIRST
       LIMIT $1
      `,
      [BATCH],
    );

    let productsDone = 0;
    let productsErrors = 0;
    for (const r of productRows) {
      try {
        await labelProduct(r);
        productsDone++;
      } catch {
        productsErrors++;
      }
    }

    // --- Videos ---
    const { rows: videoRows } = await dbQuery<VideoRow>(
      `
      SELECT v.id, v.title, v.description, v.tags
        FROM videos v
        JOIN video_safety_labels vsl ON vsl.video_id = v.id
       WHERE vsl.classifier_version = 'auto_pending'
          OR (vsl.classifier_version IS DISTINCT FROM 'v2'
              AND vsl.reviewed_by_human = FALSE)
       ORDER BY vsl.classified_at NULLS FIRST
       LIMIT $1
      `,
      [BATCH],
    );

    let videosDone = 0;
    let videosErrors = 0;
    for (const r of videoRows) {
      try {
        await labelVideo({ id: r.id, title: r.title, description: r.description, tags: r.tags });
        videosDone++;
      } catch {
        videosErrors++;
      }
    }

    return {
      products: { picked: productRows.length, done: productsDone, errors: productsErrors },
      videos: { picked: videoRows.length, done: videosDone, errors: videosErrors },
    };
  });
  if (result === null) return cronSkippedResponse("classify-pending");
  return NextResponse.json(result);
}

export async function GET(req: Request): Promise<Response> {
  return POST(req);
}
