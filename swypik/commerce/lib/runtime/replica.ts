/**
 * Identitatea replicii web care răspunde (pentru /api/health, /api/ready și loguri).
 * Hostname-ul containerului e unic per replică (compose/Swarm/K8s).
 */
import { hostname } from "node:os";

export function replicaInfo(): { id: string; pid: number; uptime_s: number } {
  return {
    id: process.env.REPLICA_ID || hostname(),
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
  };
}

export function releaseInfo(): { commit: string; build_time: string; deployed_at: string } {
  return {
    commit: process.env.BUILD_COMMIT || process.env.GIT_COMMIT || "unknown",
    build_time: process.env.BUILD_TIME || "unknown",
    deployed_at: process.env.DEPLOYED_AT || "unknown",
  };
}
