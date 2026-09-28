export type Video = { id: string; url: string; description: string; creator: string };
export type Product = { id: string; title: string; price: number; image: string | null };
export const API_ORIGIN = 'https://swypik.com';
// Next.js routes still live on the web origin; api.swypik.com currently serves a different API.
export function httpsMedia(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value, API_ORIGIN); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Răspuns invalid de la Swypik.');
  return value as Record<string, unknown>;
}
export function parseFeed(value: unknown): Video[] {
  const data = record(value);
  if (!Array.isArray(data.items)) throw new Error('Formatul feedului nu este recunoscut.');
  return data.items.flatMap((item) => {
    const row = record(item);
    if (row.kind !== 'video') return [];
    const video = record(row.video);
    const url = httpsMedia(video.hlsUrl) ?? httpsMedia(video.url) ?? httpsMedia(video.fallbackUrl);
    if (!url || typeof video.id !== 'string') return [];
    const creator = video.creator && typeof video.creator === 'object' ? video.creator as Record<string, unknown> : {};
    return [{ id: video.id, url, description: typeof video.description === 'string' ? video.description : '', creator: typeof creator.username === 'string' ? creator.username : 'Swypik' }];
  });
}
export function parseProducts(value: unknown): { products: Product[]; currency: string } {
  const data = record(value);
  if (!Array.isArray(data.products)) throw new Error('Formatul catalogului nu este recunoscut.');
  const products = data.products.flatMap((entry) => {
    const p = record(entry);
    if (typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0) return [];
    return [{ id: p.id, title: p.title, price: p.price, image: httpsMedia(p.thumbnail) }];
  });
  return { products, currency: typeof data.currency === 'string' ? data.currency : 'RON' };
}
export async function readApi(path: '/api/explore/feed?limit=12' | '/api/products?mode=video&limit=12', signal: AbortSignal, webPreview = false): Promise<unknown> {
  const response = await fetch(webPreview ? '/preview?kind=' + (path.startsWith('/api/explore') ? 'feed' : 'products') : API_ORIGIN + path, { signal, credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 429 ? 'Prea multe cereri. Încearcă din nou mai târziu.' : `Swypik nu răspunde momentan (${response.status}).`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Serverul nu a returnat datele așteptate.');
  return response.json();
}

