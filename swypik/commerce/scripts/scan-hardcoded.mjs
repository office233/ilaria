#!/usr/bin/env node
/**
 * scan-hardcoded — numără textele de interfață hardcodate (netraduse) din
 * componentele client și paginile din `app/` și `components/`.
 *
 * Folosit de scripts/i18n-guard.mjs (pre-commit): commit-ul e blocat doar dacă
 * numărul CREȘTE față de `.i18n-baseline.json` — hardcodările istorice sunt
 * tolerate, cele noi nu. Ieșire: `files: N hits: M` + primele potriviri.
 * `--all` listează toate potrivirile; `--json` le scrie ca JSON.
 *
 * Ce numără: text JSX între tag-uri (`>Text<`), atributele placeholder/title/
 * aria-label/alt/label și `alert`/`confirm`/`toast.*("...")`, dacă textul e
 *   - românesc: diacritice SAU un cuvânt românesc frecvent (și fără diacritice:
 *     „Despre”, „Cerere retur”, „Autentificare”), SAU
 *   - englezesc de interfață: conține un cuvânt tipic de UI („Loading…”,
 *     „No image”, „Save”, „Try again”).
 * Ce ignoră: className, import-uri, comentarii, fișierele de test, `messages/`,
 * textul din `{...}` (expresii), nume proprii fără cuvinte de UI („Swypik”).
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["app", "components"];
const EXT = new Set([".tsx"]);
const DIACRITICS = /[ăâîșțşţĂÂÎȘȚŞŢ]/;

// Cuvinte românești frecvente în UI — inclusiv formele scrise FĂRĂ diacritice.
const RO_WORDS = new RegExp(
  "\\b(" +
    [
      "și", "si", "sau", "pentru", "din", "este", "sunt", "acum", "aici", "către", "catre", "fără", "fara",
      "după", "dupa", "până", "pana", "cumpără", "cumpara", "adaugă", "adauga", "caută", "cauta", "trimite",
      "salvează", "salveaza", "închide", "inchide", "deschide", "înapoi", "inapoi", "următorul", "urmatorul",
      "comandă", "comanda", "comenzii", "comenzi", "coș", "cos", "preț", "pret", "reducere", "livrare",
      "client", "clienți", "clienti", "factură", "factura", "facturi", "vânzare", "vanzare", "vânzări", "vanzari",
      "produs", "produse", "despre", "facem", "diferit", "ajutor", "cerere", "retur", "retururi", "returul",
      "returului", "cantitate", "videoclipuri", "videoclip", "ascunse", "ascuns", "autentificare", "motivul",
      "plata", "plată", "clipuri", "culoare", "mărime", "marime", "anulează", "anuleaza", "șterge", "sterge",
      "editează", "editeaza", "continuă", "continua", "încarcă", "incarca", "niciun", "nicio", "toate",
      "vezi", "detalii", "adresa", "adresă", "parola", "parolă", "contul", "setări", "setari", "notificări",
      "notificari", "mesaje", "urmăritori", "urmaritori", "magazin", "categorii", "categorie", "vânzător",
      "vanzator", "comision", "comisioane", "rambursare", "rambursări", "rambursari", "utilizator", "utilizatori",
      "aprobă", "aproba", "respinge", "aprobat", "respins", "în", "cu", "la", "de la", "nu", "da",
    ].join("|") +
    ")\\b",
  "i",
);

// Cuvinte englezești tipice de interfață (text vizibil, nu cod).
const EN_UI_WORDS = new RegExp(
  "\\b(" +
    [
      "loading", "no image", "image", "error", "save", "cancel", "delete", "edit", "submit", "close",
      "back", "next", "previous", "search", "login", "log in", "logout", "log out", "sign in", "sign up",
      "settings", "profile", "retry", "try again", "something went wrong", "untitled", "add", "remove",
      "update", "confirm", "continue", "view", "show more", "show less", "select", "upload", "download",
      "share", "follow", "unfollow", "reply", "send", "quantity", "total", "cart", "checkout", "orders?",
      "account", "password", "email", "no results", "not found", "failed", "success", "saved", "please",
      "your", "you", "the", "and", "with", "for", "from", "this", "are", "is", "not", "click", "here",
    ].join("|") +
    ")\\b",
  "i",
);

const IGNORE_DIRS = new Set(["node_modules", ".next", "tests", "__tests__"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(entry.name)) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
}

/** Text care seamănă a cod/identificator, nu a propoziție pentru oameni. */
function looksLikeCode(t) {
  return (
    /^[\w.-]+\(|=>|&&|\|\||===|^[\w-]+:[\w-]+$|^[A-Z0-9_]+$|^\W+$|^[\d\s.,:%/+-]+$/.test(t) ||
    /^(?:https?:|\/)[\w./?=&%-]*$/.test(t) ||
    // Adresă de email exemplu (placeholder „nume@email.ro”) — nu e text de tradus.
    /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(t)
  );
}

export function isHardcodedUiText(text) {
  const t = text.trim().replace(/&[a-z]+;|&#\d+;/gi, " ").trim();
  if (t.length < 3 || !/[A-Za-zăâîșțĂÂÎȘȚ]{2,}/.test(t) || looksLikeCode(t)) return false;
  if (DIACRITICS.test(t)) return true;
  if (RO_WORDS.test(t)) return true;
  return EN_UI_WORDS.test(t);
}

const PATTERNS = [
  /(?<=>)[^<>{}\n]*[A-Za-zăâîșțĂÂÎȘȚ]{3,}[^<>{}\n]*(?=<)/g, // text JSX
  /(?:placeholder|title|aria-label|alt|label)="([^"]{3,})"/g, // atribute
  /(?:\balert|\bconfirm|toast\.(?:error|success|info|warning|message))\(\s*["'`]([^"'`$]{3,})["'`]/g, // dialoguri/toast
];

export function scanSource(src) {
  const found = [];
  src.split("\n").forEach((line, idx) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || (/className=|from ["']/.test(line) && !/>[^<]+</.test(line))) return;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const text = m[1] ?? m[0];
        if (isHardcodedUiText(text)) found.push({ line: idx + 1, text: text.trim().slice(0, 70) });
      }
    }
  });
  return found;
}

function main() {
  const files = [];
  for (const root of ROOTS) if (fs.existsSync(root)) walk(root, files);
  const all = [];
  for (const file of files) {
    for (const hit of scanSource(fs.readFileSync(file, "utf8"))) {
      all.push({ file: file.replace(/\\/g, "/"), ...hit });
    }
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  console.log(`files: ${files.length} hits: ${all.length}`);
  const limit = process.argv.includes("--all") ? all.length : 30;
  for (const h of all.slice(0, limit)) console.log(`  ${h.file}:${h.line}: ${h.text}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main();
}
