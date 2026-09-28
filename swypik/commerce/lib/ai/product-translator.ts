/**
 * Product translation via Azure OpenAI (structured output, lib/ai/azure).
 * Used by the seller wizard fan-out and by the batch script.
 *
 * Produces SEO-friendly titles + descriptions per target locale and persists
 * them into product_translations. Safe to call fire-and-forget — every error
 * is caught and logged.
 */

import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { AzureAIError, chatDeployment, chatJson, isAzureChatConfigured } from "@/lib/ai/azure";
import { logger } from "@/lib/logger";
import type { Locale } from "@/lib/i18n/config";

const PROMPT_VERSION = "v2";
const modelTag = () => `azure:${chatDeployment() ?? "unset"}-prompt-${PROMPT_VERSION}`;

const TranslateSchema = z.object({
  title: z.string().min(10).max(250),
  description: z.string().max(2000).optional().nullable(),
  seo_title: z.string().max(80).optional().nullable(),
  seo_description: z.string().max(220).optional().nullable(),
  slug: z.string().max(120).optional().nullable(),
});

const LOCALE_LABELS: Record<Locale, string> = {
  ro: "Romanian (limba română)",
  en: "English",
  es: "Spanish (español)",
  fr: "French (français)",
  de: "German (Deutsch)",
  pt: "Portuguese (português)",
  it: "Italian (italiano)",
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

type TranslateResult = {
  title: string;
  description: string | null;
  seo_title: string | null;
  seo_description: string | null;
  slug: string | null;
};

const SYSTEM = (sourceLocale: Locale, targetLocale: Locale) => `You translate e-commerce product listings from ${LOCALE_LABELS[sourceLocale]} into ${LOCALE_LABELS[targetLocale]}.

FIELDS (targets are HARD requirements, not suggestions):
- title: 60–95 chars, natural commercial style, no ALL-CAPS, no emoji. Include key attributes (brand, material, color, size, gender, quantity).
- description: 200–600 chars. If source description is empty, write 2–3 informative sentences from the title. Concrete attributes only, no fluff.
- seo_title: 50–60 chars HARD. Suitable for HTML <title>. If you cannot fit key keywords in 60 chars, drop secondary words but stay in range.
- seo_description: 140–160 chars HARD. Compelling meta snippet. Include 1 call-to-action verb and 1–2 keywords.
- slug: lowercase, hyphenated ASCII, max 90 chars.

PRESERVE EXACTLY (never translate, never reformat):
- Brand names (Suninheart, Karrram, Samsung, iPhone, etc.)
- Model codes (EB-BA546ABY, A54, V8050, etc.)
- Quantity prefixes (1Pcs → "1 buc", 2pcs → "2 buc", Set of 3 → "Set 3 buc")
- Numeric specs (5000mAh, 360°, S–XL, etc.)

NEVER: invent features, prices, certifications, country of origin. NEVER ALL-CAPS or clickbait. NEVER translate brand names.

Return strict JSON, no markdown fences:
{"title":"...","description":"...","seo_title":"...","seo_description":"...","slug":"..."}

FEW-SHOT (English → ${LOCALE_LABELS[targetLocale]}):
INPUT: {"source_title":"NEW 1Pcs Portable Travel Toothbrush Foldable Soft Hair Dental Brush Adult","source_description":""}
OUTPUT: {"title":"Periuță de dinți pliabilă portabilă pentru călătorie, 1 buc, peri moi pentru adulți","description":"Periuță de dinți pliabilă, ușor de transportat în trusa de voiaj. Perii moi protejează gingiile, iar designul compact menține igiena între utilizări. Ideală pentru deplasări.","seo_title":"Periuță Dinți Pliabilă Călătorie 1 buc – Peri Moi Adulți","seo_description":"Descoperă periuța de dinți pliabilă portabilă pentru călătorie, cu peri moi pentru adulți. Compactă, igienică, ideală în orice trusă de voiaj.","slug":"periuta-dinti-pliabila-portabila-calatorie"}

INPUT: {"source_title":"Brand New EB-BA546ABY 5000mAh Battery For Samsung Galaxy A54 5G A546 / A34 5G A346","source_description":""}
OUTPUT: {"title":"Baterie nouă EB-BA546ABY 5000mAh pentru Samsung Galaxy A54 5G (A546) și A34 5G (A346)","description":"Baterie de schimb originală EB-BA546ABY, capacitate 5000mAh, compatibilă cu Samsung Galaxy A54 5G (A546) și A34 5G (A346). Performanță stabilă și autonomie extinsă pentru utilizare zilnică.","seo_title":"Baterie EB-BA546ABY 5000mAh Samsung Galaxy A54/A34 5G","seo_description":"Comandă bateria EB-BA546ABY de 5000mAh pentru Samsung Galaxy A54 5G și A34 5G. Compatibilitate garantată, autonomie extinsă, montaj rapid.","slug":"baterie-eb-ba546aby-5000mah-samsung-a54-a34-5g"}`;

async function translateOne(
  title: string,
  description: string | null,
  sourceLocale: Locale,
  targetLocale: Locale,
): Promise<TranslateResult | null> {
  if (!isAzureChatConfigured()) return null;
  if (sourceLocale === targetLocale) {
    return {
      title,
      description,
      seo_title: title.slice(0, 60),
      seo_description: description ? description.slice(0, 155) : null,
      slug: slugify(title),
    };
  }
  const userPayload = JSON.stringify({ source_title: title, source_description: description || "" });
  try {
    const { data: parsed } = await chatJson(
      [
        { role: "system", content: SYSTEM(sourceLocale, targetLocale) },
        { role: "user", content: userPayload },
      ],
      { feature: "product-translate", schema: TranslateSchema, schemaName: "product_translation", maxCompletionTokens: 2500, timeoutMs: 20_000 },
    );
    return {
      title: parsed.title.slice(0, 250),
      description: parsed.description ? String(parsed.description).slice(0, 2000) : null,
      seo_title: parsed.seo_title ? String(parsed.seo_title).slice(0, 80) : null,
      seo_description: parsed.seo_description ? String(parsed.seo_description).slice(0, 220) : null,
      slug: parsed.slug ? slugify(String(parsed.slug)) : slugify(String(parsed.title)),
    };
  } catch (e) {
    logger.warn({ code: e instanceof AzureAIError ? e.code : "unknown", sourceLocale, targetLocale }, "[translator] azure error");
    return null;
  }
}

export async function translateProductToLocales(args: {
  productId: string;
  sourceLocale: Locale;
  title: string;
  description: string | null;
  targetLocales: Locale[];
}): Promise<{ written: Locale[]; skipped: Locale[] }> {
  const written: Locale[] = [];
  const skipped: Locale[] = [];
  for (const loc of args.targetLocales) {
    const r = await translateOne(args.title, args.description, args.sourceLocale, loc);
    if (!r) { skipped.push(loc); continue; }
    try {
      await dbQuery(
        `INSERT INTO product_translations
           (product_id, locale, title, description, slug, seo_title, seo_description, source, model_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'llm', $8)
         ON CONFLICT (product_id, locale) DO UPDATE
           SET title = EXCLUDED.title,
               description = EXCLUDED.description,
               slug = EXCLUDED.slug,
               seo_title = EXCLUDED.seo_title,
               seo_description = EXCLUDED.seo_description,
               source = CASE WHEN product_translations.source = 'seller' THEN 'seller' ELSE 'llm' END,
               model_tag = EXCLUDED.model_tag`,
        [args.productId, loc, r.title, r.description, r.slug, r.seo_title, r.seo_description, modelTag()],
      );
      written.push(loc);
    } catch (e: any) {
      logger.warn({ err: e?.message, productId: args.productId, loc }, "[translator] db insert failed");
      skipped.push(loc);
    }
  }
  return { written, skipped };
}
