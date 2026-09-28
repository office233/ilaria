#!/usr/bin/env node
/**
 * check-env.mjs — validează configurația de mediu înainte de deploy/pornire.
 *
 * Utilizare:
 *   node scripts/check-env.mjs            # citește .env.local / .env dacă există
 *   NODE_ENV=production node scripts/check-env.mjs
 *
 * Exit code 1 dacă lipsesc variabile OBLIGATORII (în producție).
 * Variabilele recomandate produc doar avertismente.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());

/** Încarcă .env fără dependențe externe (nu suprascrie env-ul deja setat). */
function loadEnvFile(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return false;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

const loaded = [".env.local", ".env"].filter(loadEnvFile);

const isProd = process.env.NODE_ENV === "production";

/** @type {{name:string, why:string, prodOnly?:boolean}[]} */
const REQUIRED = [
  { name: "DATABASE_URL", why: "conexiunea PostgreSQL" },
  { name: "APP_ENCRYPTION_KEY", why: "criptare tokenuri/sesiuni sociale, semnături unsubscribe" },
  { name: "NEXT_PUBLIC_APP_URL", why: "URL public canonic (linkuri e-mail, redirect-uri)" },
  { name: "CRON_SECRET", why: "protejează rutele /api/cron/*", prodOnly: true },
  { name: "STRIPE_SECRET_KEY", why: "plăți", prodOnly: true },
  { name: "STRIPE_WEBHOOK_SECRET", why: "verificarea semnăturii webhook Stripe", prodOnly: true },
  { name: "OAUTH_REDIRECT_BASE", why: "callback OAuth în producție", prodOnly: true },
  { name: "AZURE_OPENAI_ENDPOINT", why: "Azure AI Foundry (chat, Whisper)", prodOnly: true },
  { name: "AZURE_OPENAI_API_KEY", why: "cheie Azure OpenAI", prodOnly: true },
  { name: "AZURE_OPENAI_CHAT_DEPLOYMENT", why: "deployment chat (știri, asistent shop, traduceri)", prodOnly: true },
  { name: "AZURE_OPENAI_WHISPER_DEPLOYMENT", why: "deployment Whisper (subtitrări)", prodOnly: true },
  { name: "AZURE_CONTENT_SAFETY_ENDPOINT", why: "moderare text + imagine", prodOnly: true },
  { name: "AZURE_CONTENT_SAFETY_KEY", why: "cheie Content Safety", prodOnly: true },
  { name: "GO_API_URL", why: "platform API Go (upload video, feed)", prodOnly: true },
];

/** @type {{name:string, why:string}[]} */
const RECOMMENDED = [
  { name: "VAPID_PUBLIC_KEY", why: "push web (npx web-push generate-vapid-keys)" },
  { name: "VAPID_PRIVATE_KEY", why: "push web" },
  { name: "VAPID_SUBJECT", why: "mailto: pentru VAPID" },
  { name: "RESEND_API_KEY", why: "e-mailuri tranzacționale (altfel doar log)" },
  { name: "PAYOUT_MIN_CENTS", why: "prag minim retragere (default 5000)" },
  { name: "PLATFORM_USER_ID", why: "cont tehnic comisioane wallet_ledger" },
  { name: "CREATOR_COMMISSION_BPS", why: "comision creator în bps (default 500)" },
  { name: "DEFAULT_TIMEZONE", why: "fus orar implicit (default Europe/Bucharest)" },
  { name: "LIVE_RTMP_HOST", why: "live streaming — host RTMP" },
  { name: "LIVE_HLS_HOST", why: "live streaming — host HLS" },
  { name: "SOCIAL_API_URL", why: "proxy către API-ul social (fallback GO_API_URL)" },
  { name: "FEED_EVENT_IP_SALT", why: "salt hashing IP pentru evenimente feed" },
  { name: "GOOGLE_MAPS_API_KEY", why: "estimări rută (fallback haversine)" },
];

const has = (n) => {
  const v = process.env[n];
  return typeof v === "string" && v.trim() !== "";
};

const missingRequired = REQUIRED.filter((v) => (!v.prodOnly || isProd) && !has(v.name));
const missingRecommended = RECOMMENDED.filter((v) => !has(v.name));
const skippedProdOnly = REQUIRED.filter((v) => v.prodOnly && !isProd && !has(v.name));

console.log(`check-env — NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
console.log(`fișiere încărcate: ${loaded.length ? loaded.join(", ") : "(niciunul)"}`);
console.log("");

if (missingRequired.length === 0) {
  console.log("OK: toate variabilele obligatorii sunt setate.");
} else {
  console.log("LIPSESC (obligatorii):");
  for (const v of missingRequired) console.log(`  - ${v.name}  — ${v.why}`);
}

if (missingRecommended.length) {
  console.log("");
  console.log("Avertisment (recomandate, funcționalitate degradată dacă lipsesc):");
  for (const v of missingRecommended) console.log(`  - ${v.name}  — ${v.why}`);
}

if (skippedProdOnly.length) {
  console.log("");
  console.log("Necesare doar în producție (ignorate acum):");
  for (const v of skippedProdOnly) console.log(`  - ${v.name}`);
}

console.log("");
console.log(
  `Rezumat: ${missingRequired.length} obligatorii lipsă, ${missingRecommended.length} recomandate lipsă.`
);

process.exit(missingRequired.length > 0 ? 1 : 0);
