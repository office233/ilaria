/**
 * labelProduct — classify a product and upsert into product_safety_labels.
 * Safe to call inline after INSERT; safe to call from cron worker.
 *
 * Does NOT throw — logs and returns null on error so it never blocks
 * the import pipeline.
 */
import { classifyText } from "@/lib/moderation/classifier";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type ProductLabelInput = {
  id: string;
  title?: string | null;
  description?: string | null;
  category?: string | null;
  canonical_category?: string | null;
  tags?: string[] | null;
};

export async function labelProduct(p: ProductLabelInput): Promise<void> {
  try {
    const result = classifyText({
      title: p.title ?? "",
      description: p.description ?? "",
      category: p.category ?? p.canonical_category ?? "",
      tags: p.tags ?? [],
    });

    await dbQuery(
      `
      INSERT INTO product_safety_labels
        (product_id, label, classifier_version, reasons, signals, classified_at)
      VALUES ($1, $2, 'v2', $3, $4, now())
      ON CONFLICT (product_id) DO UPDATE SET
        label              = EXCLUDED.label,
        classifier_version = EXCLUDED.classifier_version,
        reasons            = EXCLUDED.reasons,
        signals            = EXCLUDED.signals,
        classified_at      = now(),
        updated_at         = now()
      WHERE product_safety_labels.reviewed_by_human = FALSE
      `,
      [p.id, result.label, result.reasons, result.signals],
    );
  } catch (err) {
    // never block import — product stays at trigger-default 'sensitive'
    logger.error({ id: p.id, err }, "[labelProduct] failed");
  }
}
