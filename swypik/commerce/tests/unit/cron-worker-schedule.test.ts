import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RUN_SH = path.resolve(__dirname, "../../infra/hetzner/cron-worker/run.sh");
const script = readFileSync(RUN_SH, "utf8");
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** Rulează `snippet` cu funcțiile din run.sh încărcate (CRON_LIB_ONLY=1). */
function sh(snippet: string, stateDir: string, jobs?: string): string {
  const res = spawnSync("sh", ["-c", `. "$RUN_SH"; ${snippet}`], {
    env: {
      ...process.env,
      RUN_SH: RUN_SH.replace(/\\/g, "/"),
      CRON_LIB_ONLY: "1",
      CRON_STATE_DIR: stateDir.replace(/\\/g, "/"),
      // Port închis: curl eșuează imediat (TRANSPORT_FAIL), fără rețea reală.
      CRON_TARGET_URL: "http://127.0.0.1:9",
      ...(jobs ? { CRON_JOBS: jobs } : {}),
    },
    encoding: "utf8",
  });
  return `${res.stdout}${res.stderr}`;
}

describe("cron-worker run.sh — planificare pe termene, joburi în fundal", () => {
  it("nu mai folosește ferestrele modulo care săreau rulările", () => {
    expect(script).not.toMatch(/TICK % \d+\)\) -lt 60/);
    expect(script).toContain("acquire_lock");
    expect(script).toMatch(/\) &\n/);
  });

  it("programează news-pipeline, missions-expire și joburile zilnice", () => {
    for (const job of ["news-pipeline|POST|7200", "missions-expire|POST|3600", "reconcile-wallets|POST|86400", "email-digest|POST|604800|378000"]) {
      expect(script).toContain(job);
    }
  });

  it.skipIf(!hasSh)("next_due aliniază la ceas (inclusiv offset săptămânal luni 09:00 UTC)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cron-"));
    const out = sh("next_due 7200 0 7300; next_due 60 0 59; next_due 604800 378000 1790000000", dir).trim().split(/\s+/);
    expect(out[0]).toBe("14400");
    expect(out[1]).toBe("60");
    const weekly = Number(out[2]);
    const d = new Date(weekly * 1000);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(9);
    expect(weekly).toBeGreaterThan(1790000000);
  });

  it.skipIf(!hasSh)("prima iterație doar programează; un termen depășit rulează o dată și avansează", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cron-"));
    const jobs = "\nnews-pipeline|POST|7200|0|5\nreconcile-wallets|POST|86400|0|5\n";
    sh("schedule_tick 1000", dir, jobs);
    expect(readFileSync(path.join(dir, "cron-due.news-pipeline"), "utf8").trim()).toBe("7200");
    // Bucla a întârziat (7250 > 7200): rularea NU se pierde, spre deosebire de `% 7200 < 60`.
    const log = sh("schedule_tick 7290; wait", dir, jobs);
    expect(log).not.toContain("reconcile-wallets");
    expect(log).toContain("→ news-pipeline (POST)");
    expect(log).toContain("news-pipeline TRANSPORT_FAIL");
    expect(readFileSync(path.join(dir, "cron-due.news-pipeline"), "utf8").trim()).toBe("14400");
    // Lock-ul s-a eliberat după terminare.
    expect(readdirSync(dir).some((f) => f.startsWith("cron-lock."))).toBe(false);
  }, 30_000);

  it.skipIf(!hasSh)("un job încă în lucru nu pornește a doua oară (lock per job)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cron-"));
    const log = sh(`mkdir "$CRON_STATE_DIR/cron-lock.news-pipeline"; echo $$ > "$CRON_STATE_DIR/cron-lock.news-pipeline/pid"; start_job news-pipeline POST 5; wait`, dir);
    expect(log).toContain("news-pipeline SKIP busy");
    expect(log).not.toContain("→ news-pipeline");
  }, 30_000);
});
