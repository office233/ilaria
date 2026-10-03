/**
 * Destinația CTA-ului unui card din feed-ul unei verticale.
 * Produsul are pagina `/product/[id]` (după id, nu după slug — `/p/<slug>` nu există);
 * fără entitate atașată, deschidem clipul în feed-ul explore.
 * Path-ul e fără prefix de limbă: routerul localizat îl adaugă.
 */
export function verticalItemHref(item: {
  video: { id: string };
  entity: { id: string } | null;
}): string {
  if (item.entity?.id) return `/product/${encodeURIComponent(item.entity.id)}`;
  return `/explore?v=${encodeURIComponent(item.video.id)}`;
}
