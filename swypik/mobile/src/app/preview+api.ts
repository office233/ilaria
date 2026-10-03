// Preview-only adapter for public, anonymous GETs; never forwards cookies or tokens.
const targets: Record<string, string> = {
  feed: 'https://swypik.com/api/explore/feed?limit=12',
  products: 'https://swypik.com/api/products?mode=video&limit=12',
};
export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  const target = Object.hasOwn(targets, kind) ? targets[kind] : undefined;
  if (!target) return Response.json({ error: 'invalid_preview' }, { status: 400 });
  try {
    const response = await fetch(target, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return Response.json({error:'upstream_unavailable'}, {status:502});
    return Response.json(await response.json(), {headers:{'Cache-Control':'no-store'}});
  } catch { return Response.json({error:'upstream_unavailable'}, {status:502}); }
}
