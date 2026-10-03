/**
 * Safely serialize an object for embedding inside a <script type="application/ld+json"> tag.
 * Escapes characters that could prematurely terminate the script element or be misinterpreted
 * as HTML/JS, preventing XSS via attacker-controlled fields in the JSON-LD payload.
 */
export function safeJsonLd(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}