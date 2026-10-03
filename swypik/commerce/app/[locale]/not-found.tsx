/**
 * Boundary 404 pentru segmentul [locale] (notFound() din product/[id], v/[id],
 * missions/[slug] etc.).
 *
 * Atenție: boundary-ul ăsta rulează DOAR pe client. SSR-ul React nu rulează
 * error boundaries, așa că în Next 15.5 un notFound() aruncat de o pagină
 * ajunge în shell și serverul trimitea `<html id="__next_error__">` gol
 * (vercel/next.js#98954). HTML-ul randat pe server vine din patch-ul
 * `scripts/patch-next-notfound-ssr.mjs`, care randează root layout +
 * `app/not-found.tsx`. De aceea aici re-exportăm același component: markup-ul
 * din SSR și cel de după hidratare trebuie să fie identic.
 */
export { default } from "../not-found";
