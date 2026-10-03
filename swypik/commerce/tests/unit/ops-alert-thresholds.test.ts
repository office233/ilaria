/**
 * PRAGURILE CELOR TREI PROTECȚII, testate prin mutație.
 *
 * Toate cele opt defecte reparate în 17-21 august erau PROTECȚII, nu
 * funcționalități. De asta au tăcut: o pagină ruptă are un utilizator care
 * reclamă în zece minute, un backup rupt nu are pe nimeni.
 *
 * Testele de aici nu verifică „rulează fără eroare" — verifică, pentru fiecare
 * prag, că alerta PLEACĂ atunci când trebuie și că NU pleacă altfel. Fiecare a
 * fost validat prin mutație: am stricat pragul și am confirmat că testul pică.
 *
 * DE CE DUPLICĂM LOGICA AICI
 * Cele trei praguri sunt scrise inline în rutele de sub `app/api/cron`, amestecate
 * cu autorizare, acces la DB și `notifyOps`. Nu pot fi importate într-un test
 * fără să pornească toată infrastructura. Duplicarea e o soluție de compromis,
 * asumată: dacă pragul din rută se schimbă fără să se schimbe și aici, testul
 * devine minciună. Alternativa curată — extragerea deciziei într-o funcție
 * pură, importată de ambele părți — e propusă în raport, nu făcută fără acord.
 */
import { describe, it, expect } from "vitest";

// ── 1. disk-watch ────────────────────────────────────────────────────────────
// Sursa: app/api/cron/disk-watch/route.ts (DEFAULT_THRESHOLD_GB, `freeGb >= min`)
const DISK_THRESHOLD_GB = 15;
const DISK_CRITICAL_GB = 5;

function diskDecision(freeGb: number, thresholdGb = DISK_THRESHOLD_GB) {
    if (freeGb >= thresholdGb) return { alerted: false, severity: null as string | null };
    return { alerted: true, severity: freeGb < DISK_CRITICAL_GB ? "critical" : "warning" };
}

describe("disk-watch: pragul de spațiu", () => {
    it("nu alertează când e spațiu (cazul normal, E: are ~373 GB)", () => {
        expect(diskDecision(373).alerted).toBe(false);
    });

    it("alertează exact SUB prag, nu la egalitate", () => {
        // Granița contează: la fix 15 GB încă nu alertăm, la 14.9 da.
        expect(diskDecision(15).alerted).toBe(false);
        expect(diskDecision(14.9).alerted).toBe(true);
    });

    it("escaladează la critical sub 5 GB", () => {
        expect(diskDecision(14).severity).toBe("warning");
        expect(diskDecision(4.9).severity).toBe("critical");
    });

    it("pragul de 15 GB e peste cel de 10 GB al deploy-ului", () => {
        // Intenția documentată: vrem alerta ÎNAINTE ca deploy-ul să fie blocat.
        // Dacă cineva coboară pragul sub 10, alerta devine inutilă.
        expect(DISK_THRESHOLD_GB).toBeGreaterThan(10);
    });

    it("0 GB liberi alertează critical (incidentul din 17 august)", () => {
        expect(diskDecision(0)).toEqual({ alerted: true, severity: "critical" });
    });
});

// ── 2. backup-watchdog ───────────────────────────────────────────────────────
// Sursa: app/api/cron/backup-report/route.ts
const BACKUP_MAX_AGE_HOURS = 48;
const MIN_PLAUSIBLE_BYTES = 50_000;

function backupStale(ageHours: number | null, maxAge = BACKUP_MAX_AGE_HOURS) {
    return ageHours === null || ageHours > maxAge;
}

function backupSuspect(status: string, sizeBytes: number) {
    return status === "success" && sizeBytes > 0 && sizeBytes < MIN_PLAUSIBLE_BYTES;
}

describe("backup-watchdog: detectorul de tăcere", () => {
    it("`null` (niciun backup raportat vreodată) e tratat ca depășire", () => {
        // Exact starea reală din 18 august 07:02, când watchdog-ul a alertat
        // prima dată în producție cu ageHours: null.
        expect(backupStale(null)).toBe(true);
    });

    it("backup de azi nu alertează", () => {
        expect(backupStale(11)).toBe(false);
    });

    it("granița e 48h, strict mai mare", () => {
        expect(backupStale(48)).toBe(false);
        expect(backupStale(49)).toBe(true);
    });

    it("cele 15 zile de tăcere ar fi fost prinse", () => {
        // Incidentul: 2 aug -> 17 aug, bit de execuție pierdut la git pull.
        expect(backupStale(15 * 24)).toBe(true);
    });

    it("un `succes` cu dump ridicol de mic e tot un eșec", () => {
        // Crontab-ul coboară MIN_SIZE la 100000, deci scriptul ar accepta un
        // dump de 60 KB. Watchdog-ul îl marchează oricum suspect.
        expect(backupSuspect("success", 40_000)).toBe(true);
        expect(backupSuspect("success", 660_166)).toBe(false); // dump real, 18 aug
    });

    it("un dump de 0 bytes NU e marcat suspect — e deja eșec", () => {
        // sizeBytes > 0 în condiție: 0 înseamnă că scriptul n-a produs nimic,
        // caz tratat pe ramura de failure, nu pe cea de „succes suspect".
        expect(backupSuspect("success", 0)).toBe(false);
        expect(backupSuspect("failed", 0)).toBe(false);
    });
});

// ── 3. checkout-health ───────────────────────────────────────────────────────
// Sursa: app/api/cron/checkout-health/route.ts
const CHECKOUT_MIN_ATTEMPTS = 5;
const CHECKOUT_FAIL_RATIO = 0.5;

function checkoutUnhealthy(attempts: number, failures: number) {
    if (attempts < CHECKOUT_MIN_ATTEMPTS) return false; // volum sub prag
    return failures / attempts > CHECKOUT_FAIL_RATIO;
}

describe("checkout-health: pragurile de plată", () => {
    it("volum mic nu alertează (evită falsele pozitive pe trafic zero)", () => {
        expect(checkoutUnhealthy(4, 4)).toBe(false);
    });

    it("alertează la eșec total peste pragul de volum", () => {
        expect(checkoutUnhealthy(5, 5)).toBe(true);
    });

    it("granița de 50% e strictă, nu inclusivă", () => {
        expect(checkoutUnhealthy(10, 5)).toBe(false); // fix 50%
        expect(checkoutUnhealthy(10, 6)).toBe(true);
    });

    it("cele 13 comenzi failed / 0 paid ar fi alertat", () => {
        // Starea reală a producției timp de 15 zile cu chei placeholder.
        expect(checkoutUnhealthy(13, 13)).toBe(true);
    });

    it("SLĂBICIUNE CUNOSCUTĂ: 4 eșecuri din 4 nu alertează", () => {
        // Documentat intenționat ca test, nu ca omisiune. Cu trafic real,
        // pragul de volum trebuie recalibrat — vezi planul din raport.
        expect(checkoutUnhealthy(4, 4)).toBe(false);
    });
});
