/** Small client-safe text helpers for news cards and metadata. */

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}]/gu;

/** The TL;DR as one plain line: emoji markers and line breaks removed. */
export function plainSummary(summary: string, max = 220): string {
  const text = summary.replace(EMOJI_RE, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "www.bbc.co.uk" → "bbc.co.uk"; null for unparsable URLs. */
export function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Display name for a source: publisher name, else the link's host. */
export function sourceLabel(sourceName: string | null | undefined, url: string): string {
  return sourceName?.trim() || sourceHost(url) || url;
}
