import { describe, it, expect } from "vitest";
import {
  assertNodeOnline,
  NodeOfflineError,
  validateNodeHeartbeat,
  computeNodeState,
  generateNodeId,
} from "../../lib/node/node-protocol";

describe("Swypik Local Node Engine (Noduri Locale)", () => {
  it("permite executarea operațiunilor când nodul este online", () => {
    expect(() => assertNodeOnline(true)).not.toThrow();
  });

  it("blochează strict funcționarea când nodul este offline (nu funcționează fără net)", () => {
    expect(() => assertNodeOnline(false)).toThrow(NodeOfflineError);
    expect(() => assertNodeOnline(false)).toThrow(
      "Nodul Swypik este deconectat de la rețea! Conexiunea la internet este obligatorie pentru funcționarea magazinului pe rețeaua Swypik."
    );
  });

  it("validează un heartbeat proaspăt de la nodul comerciantului", () => {
    const validHb = {
      nodeId: "NODE-RO-SELLER1",
      sellerId: "seller_123",
      timestamp: new Date().toISOString(),
      pingMs: 15,
      pendingSyncCount: 0,
      isOnline: true,
    };

    const result = validateNodeHeartbeat(validHb);
    expect(result.valid).toBe(true);
  });

  it("respinge heartbeat-ul dacă nodul nu are internet", () => {
    const offlineHb = {
      nodeId: "NODE-RO-SELLER1",
      sellerId: "seller_123",
      timestamp: new Date().toISOString(),
      pingMs: 0,
      pendingSyncCount: 2,
      isOnline: false,
    };

    const result = validateNodeHeartbeat(offlineHb);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("pierderea conexiunii");
  });

  it("respinge un heartbeat expirat / stale (> 60s)", () => {
    const expiredHb = {
      nodeId: "NODE-RO-SELLER1",
      sellerId: "seller_123",
      timestamp: new Date(Date.now() - 90000).toISOString(), // 90 seconds ago
      pingMs: 15,
      pendingSyncCount: 0,
      isOnline: true,
    };

    const result = validateNodeHeartbeat(expiredHb, 60);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Heartbeat expirat");
  });

  it("calculează corect starea nodului (online_hosting vs disconnected_error)", () => {
    const recentIso = new Date().toISOString();
    expect(computeNodeState(true, recentIso)).toBe("online_hosting");

    // Offline -> disconnected_error
    expect(computeNodeState(false, recentIso)).toBe("disconnected_error");

    // Fără heartbeat -> disconnected_error
    expect(computeNodeState(true, null)).toBe("disconnected_error");

    // Heartbeat vechi de 60 secunde -> disconnected_error
    const oldIso = new Date(Date.now() - 60000).toISOString();
    expect(computeNodeState(true, oldIso)).toBe("disconnected_error");
  });

  it("generează un Node ID determinist și lizibil", () => {
    const id = generateNodeId("seller_fashion_hub");
    expect(id).toMatch(/^NODE-RO-SELLERFA$/);
  });
});
