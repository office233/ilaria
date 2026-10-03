/**
 * Rutele canonice ale entităților sociale — folosite de notificări, share și UI,
 * ca să nu mai existe linkuri /u/<uuid> sau /v/<uuid> care dau 404.
 * Relative (fără domeniu, fără prefix de limbă): Link-ul localizat îl adaugă.
 */

export function profilePath(username: string): string {
  return `/u/${encodeURIComponent(username)}`;
}

/** Clipul în player; cu `commentId` deschide direct foaia de comentarii pe el. */
export function videoPath(videoId: string, commentId?: string | null): string {
  const base = `/explore?v=${encodeURIComponent(videoId)}`;
  return commentId ? `${base}&comment=${encodeURIComponent(commentId)}` : base;
}

/** URL absolut pentru share (window.location.origin pe client). */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}
