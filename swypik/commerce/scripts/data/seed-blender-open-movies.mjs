#!/usr/bin/env node
/**
 * Seed „Open Cinema": filmele deschise ale Blender Studio (Creative Commons BY),
 * ingerate prin API-ul admin (POST /api/admin/movies) ca CIORNE pe contul
 * oficial, cu licența completă (tip, atribuire, sursă, teritoriu).
 *
 * NU e o migrare și nu rulează automat — îl rulează ownerul, o singură dată.
 * Nu conține și nu descarcă conținut protejat: doar titluri CC BY publicate de
 * Blender Foundation, identificate prin pagina lor publică oficială.
 *
 * Fișierele video: CC BY cere păstrarea creditelor integrale; folosește DOAR
 * fișierul oficial de pe pagina proiectului (nu re-upload-uri de pe alte
 * site-uri). Logo-urile/mărcile Blender sunt excluse din licență — nu le folosi
 * ca branding Swypik. Pune URL-urile https ale fișierelor într-un JSON
 * `{ "<slug>": "https://…/fisier.mp4" }` și dă-l cu --media; titlurile fără
 * fișier se creează doar cu metadate, iar episodul se atașează din /admin/movies.
 *
 * Usage:
 *   ADMIN_SECRET=… node scripts/data/seed-blender-open-movies.mjs --base-url https://<domeniu> [--media media.json] [--apply]
 * Fără --apply: dry-run (afișează ce ar trimite).
 * După import: verifică în /admin/movies că videoul e transcodat + aprobat, apoi „Publică".
 */
import fs from "node:fs";

const BLENDER = "Blender Foundation";

/** slug, titlu, an, pagina oficială (sursa licenței), versiunea CC BY, format. */
const TITLES = [
    { slug: "elephants-dream", title: "Elephants Dream", year: 2006, page: "https://orange.blender.org/", cc: "2.5" },
    { slug: "big-buck-bunny", title: "Big Buck Bunny", year: 2008, page: "https://peach.blender.org/", cc: "3.0" },
    { slug: "sintel", title: "Sintel", year: 2010, page: "https://durian.blender.org/", cc: "3.0" },
    { slug: "tears-of-steel", title: "Tears of Steel", year: 2012, page: "https://mango.blender.org/", cc: "3.0" },
    { slug: "cosmos-laundromat", title: "Cosmos Laundromat", year: 2015, page: "https://gooseberry.blender.org/", cc: "4.0" },
    { slug: "spring", title: "Spring", year: 2019, page: "https://studio.blender.org/films/spring/", cc: "4.0" },
    { slug: "coffee-run", title: "Coffee Run", year: 2020, page: "https://studio.blender.org/films/coffee-run/", cc: "4.0" },
    { slug: "sprite-fright", title: "Sprite Fright", year: 2021, page: "https://studio.blender.org/projects/sprite-fright/", cc: "4.0" },
    { slug: "charge", title: "Charge", year: 2022, page: "https://studio.blender.org/films/charge/", cc: "4.0" },
];

function parseArgs(argv) {
    const opts = { baseUrl: "", media: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--base-url") opts.baseUrl = argv[++i] ?? "";
        else if (argv[i] === "--media") opts.media = argv[++i] ?? null;
        else if (argv[i] === "--apply") opts.apply = true;
    }
    return opts;
}

function attribution(t) {
    return `„${t.title}" (${t.year}) © ${BLENDER} | ${t.page} — Creative Commons Attribution ${t.cc}. Creditele originale sunt păstrate integral în film.`;
}

function payload(t, mediaUrl) {
    return {
        title: t.title,
        synopsis: "",
        format: "film",
        genres: [],
        languageCode: "en",
        freeEpisodes: 1,
        episodePriceCents: null,
        isAdult: false,
        mediaUrl: mediaUrl ?? null,
        license: {
            type: "cc_by",
            attributionText: attribution(t),
            sourceUrl: t.page,
            territories: ["WORLD"],
            expiresAt: null,
        },
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.baseUrl.startsWith("https://")) throw new Error("--base-url https://… obligatoriu");
    const secret = process.env.ADMIN_SECRET;
    if (opts.apply && !secret) throw new Error("ADMIN_SECRET lipsă în env");
    const media = opts.media ? JSON.parse(fs.readFileSync(opts.media, "utf8")) : {};
    for (const [slug, url] of Object.entries(media)) {
        if (typeof url !== "string" || !url.startsWith("https://")) throw new Error(`media[${slug}] trebuie să fie URL https`);
    }

    for (const t of TITLES) {
        const body = payload(t, media[t.slug]);
        if (!opts.apply) {
            console.log(`[dry-run] ${t.title} → media: ${body.mediaUrl ?? "(de atașat din admin)"}`);
            continue;
        }
        const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/api/admin/movies`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            console.error(`✗ ${t.title}: ${res.status} ${data.error ?? ""} ${data.detail ?? ""}`);
            continue;
        }
        const blockers = (data.publishBlockers ?? []).join(", ") || "—";
        console.log(`✓ ${t.title}: ${data.series?.slug} (episod: ${data.episode ? "în transcodare" : "neatașat"}; blocaje publicare: ${blockers})`);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
