/**
 * CNP (Cod Numeric Personal) — validare + stocare securizată.
 *
 * DE CE îl colectăm:
 *   - DAC7 (Directiva UE 2021/514, transpusă în Codul de Procedură Fiscală):
 *     platformele digitale trebuie să raporteze ANAF veniturile vânzătorilor
 *     și să colecteze TIN-ul (pentru persoane fizice române = CNP).
 *   - Verificarea identității gazdei (anti-fraudă).
 *
 * CUM îl stocăm (minimizare + securitate):
 *   - criptat AES-256-GCM cu APP_ENCRYPTION_KEY (nu în clar, niciodată)
 *   - hash SHA-256 separat, pentru detectarea duplicatelor fără decriptare
 *   - în UI se afișează DOAR mascat (1******â€¦1234 → primele 1 + ultimele 4)
 *   - decriptarea se face doar la raportare fiscală / cerere legală
 */
import crypto from "node:crypto";

function getKey(): Buffer {
    const hex = process.env.APP_ENCRYPTION_KEY || "";
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error("APP_ENCRYPTION_KEY missing or invalid (expected 32-byte hex)");
    }
    return Buffer.from(hex, "hex");
}

/** Cifra de control CNP (algoritm oficial, cheia 279146358279). */
export function isValidCnp(cnp: string): boolean {
    const s = cnp.trim();
    if (!/^\d{13}$/.test(s)) return false;

    const key = "279146358279";
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * Number(key[i]);
    let control = sum % 11;
    if (control === 10) control = 1;
    if (control !== Number(s[12])) return false;

    // Validare dată nașterii (S AA LL ZZ ...).
    const century: Record<string, number> = {
        "1": 1900, "2": 1900, "3": 1800, "4": 1800, "5": 2000, "6": 2000, "7": 1900, "8": 1900, "9": 1900,
    };
    const base = century[s[0]];
    if (!base) return false;
    const year = base + Number(s.slice(1, 3));
    const month = Number(s.slice(3, 5));
    const day = Number(s.slice(5, 7));
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;

    // Județul (07-08 = 01..52 sau 70 pentru București sectoare vechi).
    const county = Number(s.slice(7, 9));
    if (county < 1 || (county > 52 && county !== 70)) return false;

    return true;
}

/** Vârsta derivată din CNP — gazdele trebuie să fie majore. */
export function ageFromCnp(cnp: string): number | null {
    if (!/^\d{13}$/.test(cnp)) return null;
    const century: Record<string, number> = {
        "1": 1900, "2": 1900, "3": 1800, "4": 1800, "5": 2000, "6": 2000, "7": 1900, "8": 1900, "9": 1900,
    };
    const base = century[cnp[0]];
    if (!base) return null;
    const birth = new Date(Date.UTC(base + Number(cnp.slice(1, 3)), Number(cnp.slice(3, 5)) - 1, Number(cnp.slice(5, 7))));
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const m = now.getUTCMonth() - birth.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
    return age;
}

/** Criptare pentru stocare: "iv:authTag:ciphertext" (toate hex). */
export function encryptCnp(cnp: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(cnp.trim(), "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

/** Decriptare — DOAR pentru raportare fiscală sau cerere legală. */
export function decryptCnp(stored: string): string {
    const [ivHex, tagHex, dataHex] = stored.split(":");
    if (!ivHex || !tagHex || !dataHex) throw new Error("format CNP criptat invalid");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** Hash pentru detectarea duplicatelor fără decriptare (cu pepper). */
export function hashCnp(cnp: string): string {
    const pepper = process.env.APP_ENCRYPTION_KEY || "";
    return crypto.createHash("sha256").update(`cnp:${pepper}:${cnp.trim()}`).digest("hex");
}

/** Mascare pentru afișare: 1901234567890 → 1*********7890 */
export function maskCnp(cnp: string): string {
    const s = cnp.trim();
    if (s.length !== 13) return "•••";
    return `${s[0]}${"•".repeat(8)}${s.slice(9)}`;
}
