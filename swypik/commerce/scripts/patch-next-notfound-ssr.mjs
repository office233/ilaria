#!/usr/bin/env node
// Patch pentru Next 15.5: notFound() aruncat dintr-o pagină întoarce 404 cu
// un HTML gol (`<html id="__next_error__"><head></head><body></body>`), iar
// not-found.tsx apare doar după hidratare. Crawlerele și clienții fără JS
// primesc o pagină albă, fără `lang`, h1 sau navigație.
//
// Cauza (upstream: https://github.com/vercel/next.js/issues/98954):
// HTTPAccessFallbackBoundary e un error boundary de client, iar SSR-ul React
// (Fizz) nu rulează error boundaries. Eroarea NEXT_HTTP_ERROR_FALLBACK;404
// ajunge în shell, Next o prinde în renderToStream și randează payload-ul
// din getErrorRSCPayload — care e hardcodat la documentul gol de mai sus.
// Un URL nepotrivit NU are problema, pentru că Next randează direct arborele
// root layout + not-found ca pagină.
//
// Patch-ul: în getErrorRSCPayload, pentru errorType "not-found" la randare
// dinamică, întoarce getRSCPayload pentru arborele [root layout → root
// not-found], adică exact ce se randează pentru un URL nepotrivit. Root
// layout-ul ia limba din header-ul pus de middleware-ul next-intl, deci
// `<html lang>` e corect. Statusul rămâne 404 (e setat înainte de apel).
// Datele RSC inline rămân cele ale randării originale, deci hidratarea arată
// boundary-ul [locale]/not-found — același markup (vezi app/[locale]/not-found.tsx).
//
// Generarea statică e lăsată neatinsă (root layout-ul citește cookies()).
//
// Rulează din `prebuild` și `postinstall`. Idempotent. Dacă nu recunoaște
// bundle-urile (alt Next), iese cu cod 1: verifică dacă upstream a reparat
// problema și șterge patch-ul, sau adaptează regex-urile.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const MARKER = "/*swypik:notfound-ssr*/";
const require = createRequire(import.meta.url);

let nextDir;
try {
  nextDir = path.dirname(require.resolve("next/package.json"));
} catch {
  console.log("[patch-next-notfound-ssr] next nu e instalat — skip");
  process.exit(0);
}

const bundleDir = path.join(nextDir, "dist", "compiled", "next-server");
const bundles = [
  "app-page.runtime.prod.js",
  "app-page-turbo.runtime.prod.js",
  "app-page-experimental.runtime.prod.js",
  "app-page-turbo-experimental.runtime.prod.js",
];

// async function X(tree, ctx, ssrError, errorType){let{getDynamicParamFromSegment:..,query:..,appUsingSizeAdjustment:..,componentMod:{createMetadataComponents:
const ERROR_PAYLOAD_RE =
  /async function (\w+)\((\w+),(\w+),(\w+),(\w+)\)\{(?=let\{getDynamicParamFromSegment:\w+,query:\w+,appUsingSizeAdjustment:\w+,componentMod:\{createMetadataComponents:)/g;
// async function X(tree, ctx, is404){let n,i=new Set,a=new Set,s=new Set,{getDynamicParamFromSegment ... ["global-not-found"]
const RSC_PAYLOAD_RE =
  /async function (\w+)\(\w+,\w+,\w+\)\{let \w+,\w+=new Set,\w+=new Set,\w+=new Set,\{getDynamicParamFromSegment[^}]*\}[^;]*?\["global-not-found"\]/g;

let failed = false;
for (const name of bundles) {
  const file = path.join(bundleDir, name);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  if (src.includes(MARKER)) {
    console.log(`[patch-next-notfound-ssr] ${name}: deja aplicat`);
    continue;
  }
  const errMatches = [...src.matchAll(ERROR_PAYLOAD_RE)];
  const rscMatches = [...src.matchAll(RSC_PAYLOAD_RE)];
  if (errMatches.length !== 1 || rscMatches.length !== 1) {
    console.error(
      `[patch-next-notfound-ssr] ${name}: nu recunosc bundle-ul ` +
        `(getErrorRSCPayload=${errMatches.length}, getRSCPayload=${rscMatches.length} potriviri).`,
    );
    failed = true;
    continue;
  }
  const [whole, , tree, ctx, , errorType] = errMatches[0];
  const getRSCPayload = rscMatches[0][1];
  const injected =
    `${MARKER}if("not-found"===${errorType}&&!${ctx}.workStore.isStaticGeneration){` +
    `let c=${tree}[2];` +
    `if(c.layout&&c["not-found"]&&!c["global-not-found"])` +
    `return ${getRSCPayload}(["",{children:["__PAGE__",{},{page:c["not-found"]}]},c],${ctx},!0)}`;
  const idx = errMatches[0].index + whole.length;
  writeFileSync(file, src.slice(0, idx) + injected + src.slice(idx));
  console.log(`[patch-next-notfound-ssr] ${name}: aplicat`);
}

if (failed) process.exit(1);
