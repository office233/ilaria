/**
 * Sweep-ul Live (cron /api/cron/live-sweep, protejat de lock-ul runCron):
 *  - streamurile SFU live fără heartbeat de la gazdă → ended;
 *  - pentru celelalte: numărul de spectatori din Redis → DB (+ vârf) + fan-out;
 *  - streamurile 'live' rămase pe providerii scoși (LiveKit / RTMP-MediaMTX) nu
 *    mai pot fi urmărite de nimeni → ended (onest, fără „live” fantomă).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { decideTransition } from "./access";
import { publishLiveState } from "./events";
import { updateViewerCount } from "./lifecycle";
import { endLiveStream } from "./media";
import { countViewers, hostSession } from "./presence";

const SWEEP_BATCH = 500;

export type SweepResult = { checked: number; ended: number; updated: number; legacyEnded: number };

export async function sweepLiveStreams(): Promise<SweepResult> {
  const { rows } = await dbQuery<{ id: string; provider: string }>(
    `SELECT id, provider FROM live_streams WHERE status = 'live' ORDER BY started_at ASC NULLS FIRST LIMIT $1`,
    [SWEEP_BATCH],
  );
  const result: SweepResult = { checked: rows.length, ended: 0, updated: 0, legacyEnded: 0 };

  for (const row of rows) {
    try {
      if (row.provider !== "cf_sfu") {
        if (await endLiveStream(row.id)) result.legacyEnded++;
        continue;
      }
      const hostAlive = Boolean(await hostSession(row.id));
      if (decideTransition({ status: "live", hostAlive, mediaActive: null }) === "end") {
        if (await endLiveStream(row.id)) result.ended++;
        continue;
      }
      const viewers = await countViewers(row.id);
      await updateViewerCount(row.id, viewers);
      await publishLiveState(row.id, { status: "live", viewers });
      result.updated++;
    } catch (err) {
      logger.warn({ err, streamId: row.id }, "[live/sweep] stream check failed");
    }
  }
  return result;
}
