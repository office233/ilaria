/** Digestul săptămânal — MARKETING (flag + consimțământ verificate de cron, footer de dezabonare). */
import type { Locale } from "@/lib/i18n/config";
import { emailLink } from "../links";
import type { EmailBlock } from "../layout";
import { deliver, greeting, money, tr } from "./base";

export type DigestProduct = {
  id: string;
  title: string;
  slug: string | null;
  image_url: string | null;
  price_cents: number | null;
  currency: string;
};
export type DigestVideo = { id: string; title: string | null; creator_name: string | null };

export async function sendDigestEmail(input: {
  to: string;
  locale: Locale;
  firstName: string | null;
  products: DigestProduct[];
  videos: DigestVideo[];
}): Promise<boolean> {
  const { locale } = input;
  const x = await tr(locale, "digest");
  const blocks: EmailBlock[] = [greeting(x.tc, input.firstName), { type: "p", text: x.t("intro") }];
  if (input.products.length) {
    blocks.push({ type: "heading", text: x.t("trending") });
    blocks.push({
      type: "cards",
      items: input.products.map((p) => ({
        title: p.title,
        href: emailLink(locale, `/product/${encodeURIComponent(p.slug || p.id)}`),
        image: p.image_url && /^https:\/\//i.test(p.image_url) ? p.image_url : null,
        meta: p.price_cents == null ? null : money(locale, p.price_cents, p.currency),
      })),
    });
  }
  if (input.videos.length) {
    blocks.push({ type: "heading", text: x.t("fromCreators") });
    blocks.push({
      type: "list",
      items: input.videos.map((v) => ({
        label: v.title || x.t("untitledVideo"),
        href: emailLink(locale, `/video/${encodeURIComponent(v.id)}`),
        meta: v.creator_name,
      })),
    });
  }
  blocks.push({ type: "button", label: x.t("cta"), href: emailLink(locale, "/explore") });
  return deliver({
    to: input.to,
    subject: x.t("subject"),
    title: x.t("title"),
    preheader: x.t("intro"),
    tr: x,
    blocks,
    marketing: true,
  });
}
