import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalNodeDatabase } from "../../desktop/local-node-db";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swypik-node-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
const dbFile = () => path.join(tmpDir, "local-node.json");

describe("Aplicație Desktop & Aplicație Mobilă Swypik", () => {
  it("inițializează baza de date locală a nodului desktop", () => {
    const db = new LocalNodeDatabase(dbFile());
    const info = db.getNodeInfo();

    expect(info.nodeId).toMatch(/^NODE-RO-/);
    expect(info.isOnline).toBe(true);
  });

  it("permite înregistrarea bonurilor POS când nodul este online", () => {
    const db = new LocalNodeDatabase(dbFile());
    db.data.syncStatus.isOnline = true;

    const receipt = {
      receiptNumber: "POS-TEST-100",
      totalRon: 121.0,
      tvaRon: 21.0,
      paymentMethod: "cash",
    };

    const recorded = db.recordReceipt(receipt);
    expect(recorded.receiptNumber).toBe("POS-TEST-100");
  });

  it("blochează strict înregistrarea vânzărilor când nodul este offline (regula obligatorie online)", () => {
    const db = new LocalNodeDatabase(dbFile());
    db.data.syncStatus.isOnline = false;

    expect(() => {
      db.recordReceipt({ receiptNumber: "POS-OFFLINE", totalRon: 50 });
    }).toThrow("Nodul este offline! Tranzacțiile sunt blocate");
  });
});
