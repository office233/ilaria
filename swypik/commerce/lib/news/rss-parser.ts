/**
 * Minimal, dependency-free RSS 2.0 + Atom parser for the news ingester.
 * Pure (no I/O) so it is unit-testable. Only http(s) links are accepted and
 * only https images (mixed content otherwise); nothing here is ever rendered
 * as HTML — tags are stripped and entities decoded to plain text.
 */
import type { NewsCategorySlug } from "./categories";

export interface FeedTopic {
  title: string;
  /** Source (publisher) name, e.g. "BBC Business". */
  source: string;
  sourceId: string | null;
  summary: string;
  /** Canonical link to the original article (required for attribution). */
  url: string;
  imageUrl: string | null;
  publishedAt: string | null;
  category: NewsCategorySlug;
}

const SUMMARY_MAX = 600;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function toPlainText(raw: string): string {
  return decodeEntities(unwrapCdata(raw).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}

function attr(tagXml: string, name: string): string | null {
  const m = tagXml.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? decodeEntities(m[1]).trim() : null;
}

export function isHttpUrl(value: string | null | undefined, httpsOnly = false): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return httpsOnly ? u.protocol === "https:" : u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function findImage(itemXml: string, rawDescription: string): string | null {
  const candidates: (string | null)[] = [];
  for (const m of itemXml.matchAll(/<media:(?:content|thumbnail)\b[^>]*>/gi)) {
    const medium = attr(m[0], "medium");
    const type = attr(m[0], "type");
    if (!medium || medium === "image" || type?.startsWith("image/")) candidates.push(attr(m[0], "url"));
  }
  for (const m of itemXml.matchAll(/<enclosure\b[^>]*>/gi)) {
    if (attr(m[0], "type")?.startsWith("image/")) candidates.push(attr(m[0], "url"));
  }
  const img = unwrapCdata(rawDescription).match(/<img\b[^>]*>/i);
  if (img) candidates.push(attr(img[0], "src"));
  return candidates.find((c) => isHttpUrl(c, true)) ?? null;
}

function atomLink(entryXml: string): string {
  const links = Array.from(entryXml.matchAll(/<link\b[^>]*\/?>/gi)).map((m) => m[0]);
  const alternate = links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate") ?? links[0];
  return alternate ? attr(alternate, "href") ?? "" : "";
}

function toIso(value: string): string | null {
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function parseFeed(
  xml: string,
  opts: { category: NewsCategorySlug; source: string; sourceId?: string | null; limit: number },
): FeedTopic[] {
  const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const out: FeedTopic[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (out.length >= opts.limit) break;
    const title = toPlainText(tagText(block, "title"));
    const url = (isAtom ? atomLink(block) : toPlainText(tagText(block, "link"))).trim();
    const rawDescription = isAtom ? tagText(block, "summary") || tagText(block, "content") : tagText(block, "description");
    let summary = toPlainText(rawDescription);
    if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`;
    if (!title || !isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      url,
      summary: summary || title,
      source: opts.source,
      sourceId: opts.sourceId ?? null,
      imageUrl: findImage(block, rawDescription),
      publishedAt: toIso(toPlainText(tagText(block, isAtom ? "updated" : "pubDate") || tagText(block, "published"))),
      category: opts.category,
    });
  }
  return out;
}
