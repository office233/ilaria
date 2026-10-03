import type { APIRoute } from "astro";

export const prerender = true;

const paths = ["/", "/privacy/", "/terms/", "/contact/"];

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL("https://swypik.com");
  const urls = paths
    .map((path) => `  <url><loc>${new URL(path, base).toString()}</loc></url>`)
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    {
      headers: {
        "content-type": "application/xml; charset=utf-8",
      },
    },
  );
};
