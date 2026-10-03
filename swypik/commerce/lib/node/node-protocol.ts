/**
 * Swypik Local Node Protocol (Nod Local Swypik)
 * 
 * Each merchant machine runs a Local Node with an embedded database,
 * directly hosting the seller's storefront on Swypik.
 * 
 * STRICT ARCHITECTURAL RULE:
 * Must be online! Offline functionality is disabled because the node
 * must remain synchronized and reachable by the Swypik network.
 */

export interface NodeIdentity {
  nodeId: string;
  sellerId: string;
  storeSlug: string;
  appVersion: string;
  platform: "win32" | "darwin" | "linux" | "web";
  dbType: "embedded_sqlite" | "postgres_local" | "memory";
  registeredAt: string;
}

export type NodeStatus = "online_hosting" | "syncing" | "disconnected_error";

export interface NodeHeartbeat {
  nodeId: string;
  sellerId: string;
  timestamp: string;
  pingMs: number;
  pendingSyncCount: number;
  isOnline: boolean;
}

export interface NodeStateReport {
  status: NodeStatus;
  nodeId: string;
  sellerId: string;
  isOnline: boolean;
  lastHeartbeat: string | null;
  message: string;
}

export class NodeOfflineError extends Error {
  constructor(message = "Nodul Swypik este deconectat de la rețea! Conexiunea la internet este obligatorie pentru funcționarea magazinului pe rețeaua Swypik.") {
    super(message);
    this.name = "NodeOfflineError";
  }
}

/**
 * Asserts that the local node has active internet connectivity.
 * If offline, operation is blocked immediately.
 */
export function assertNodeOnline(isOnline: boolean): void {
  if (!isOnline) {
    throw new NodeOfflineError();
  }
}

/**
 * Validates a heartbeat payload from the merchant's local machine.
 * Verifies freshness to prevent replayed or stale states.
 */
export function validateNodeHeartbeat(heartbeat: NodeHeartbeat, maxDriftSeconds = 60): { valid: boolean; reason?: string } {
  if (!heartbeat.nodeId || !heartbeat.sellerId) {
    return { valid: false, reason: "Identificator nod sau comerciant lipsă." };
  }

  if (!heartbeat.isOnline) {
    return { valid: false, reason: "Nodul a raportat pierderea conexiunii internet." };
  }

  const hbTime = new Date(heartbeat.timestamp).getTime();
  const now = Date.now();

  if (isNaN(hbTime)) {
    return { valid: false, reason: "Timestamp invalid." };
  }

  if (Math.abs(now - hbTime) > maxDriftSeconds * 1000) {
    return { valid: false, reason: "Heartbeat expirat (latență sau ceas nesincronizat)." };
  }

  return { valid: true };
}

/**
 * Computes the active hosting status of the local node.
 */
export function computeNodeState(isOnline: boolean, lastHeartbeatIso: string | null): NodeStatus {
  if (!isOnline || !lastHeartbeatIso) {
    return "disconnected_error";
  }

  const elapsedSeconds = (Date.now() - new Date(lastHeartbeatIso).getTime()) / 1000;
  if (elapsedSeconds > 45) {
    return "disconnected_error";
  }

  return "online_hosting";
}

/**
 * Generates a deterministic node ID for a seller
 */
export function generateNodeId(sellerId: string, prefix = "NODE-RO"): string {
  const clean = sellerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${prefix}-${clean || "SHOP"}`;
}
