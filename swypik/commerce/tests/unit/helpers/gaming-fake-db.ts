/**
 * In-memory stand-in for the gaming tables, enough to exercise the real SQL
 * paths of lib/gaming/xp.ts and the gaming routes (ledger UNIQUE, daily cap,
 * profile upsert, single-use tokens). Use from a test:
 *
 *   vi.mock("@/lib/db", async () => (await import("./helpers/gaming-fake-db")).dbModule);
 *   import { fake } from "./helpers/gaming-fake-db";
 */
type Row = Record<string, unknown>;

export const fake = {
  ledger: new Map<string, { id: string; xp: number }>(),
  daily: new Map<string, number>(),
  profiles: new Map<string, { xp: number; level: number; streak: number; lastDay: string | null }>(),
  /** Queued single-use rows returned by UPDATE gaming_game_sessions / gaming_trivia_rounds. */
  sessions: [] as Row[],
  rounds: [] as Row[],
  scores: [] as unknown[][],
  /** Facts returned by the activity-xp SELECT (today's video_view count). */
  activity: { views_today: 0 },
  failFor: null as RegExp | null,
  reset() {
    this.ledger.clear();
    this.daily.clear();
    this.profiles.clear();
    this.sessions = [];
    this.rounds = [];
    this.scores = [];
    this.activity = { views_today: 0 };
    this.failFor = null;
  },
};

let seq = 0;
const res = (rows: Row[] = []) => ({ rows, rowCount: rows.length });

export async function dbQuery(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
  if (fake.failFor?.test(sql)) throw new Error("fake db failure");
  const p = params as (string | number | null)[];
  if (sql.includes("INSERT INTO gaming_xp_events")) {
    const key = `${p[0]}|${p[1]}|${p[2]}`;
    if (fake.ledger.has(key)) return res();
    const id = `ev-${++seq}`;
    fake.ledger.set(key, { id, xp: 0 });
    return res([{ id }]);
  }
  if (sql.includes("UPDATE gaming_xp_events SET xp")) {
    for (const v of fake.ledger.values()) if (v.id === p[0]) v.xp = Number(p[1]);
    return res();
  }
  if (sql.includes("SELECT action, ref FROM gaming_xp_events")) {
    const rows = Array.from(fake.ledger.keys())
      .map((k) => k.split("|"))
      .filter(([u]) => u === p[0])
      .map(([, action, ref]) => ({ action, ref }));
    return res(rows);
  }
  if (sql.includes("FROM gaming_xp_events WHERE user_id = $1 AND action = 'trivia_daily'")) {
    return res(fake.ledger.has(`${p[0]}|trivia_daily|${p[1]}`) ? [{ id: "x" }] : []);
  }
  if (sql.includes("INSERT INTO gaming_xp_daily")) {
    const key = `${p[0]}|${p[1]}`;
    if (!fake.daily.has(key)) fake.daily.set(key, 0);
    return res();
  }
  if (sql.includes("SELECT xp_earned FROM gaming_xp_daily")) return res([{ xp_earned: fake.daily.get(`${p[0]}|${p[1]}`) ?? 0 }]);
  if (sql.includes("UPDATE gaming_xp_daily SET xp_earned")) {
    const key = `${p[0]}|${p[1]}`;
    fake.daily.set(key, (fake.daily.get(key) ?? 0) + Number(p[2]));
    return res();
  }
  if (sql.includes("INSERT INTO gaming_user_profiles (user_id, xp_points)")) {
    const cur = fake.profiles.get(String(p[0])) ?? { xp: 0, level: 1, streak: 0, lastDay: null };
    cur.xp += Number(p[1]);
    fake.profiles.set(String(p[0]), cur);
    return res([{ xp_points: String(cur.xp) }]);
  }
  if (sql.includes("UPDATE gaming_user_profiles SET level")) {
    const cur = fake.profiles.get(String(p[0]));
    if (cur) cur.level = Number(p[1]);
    return res();
  }
  if (sql.includes("to_char(last_trivia_at")) {
    const cur = fake.profiles.get(String(p[0]));
    return res(cur ? [{ last_day: cur.lastDay, streak: cur.streak }] : []);
  }
  if (sql.includes("INSERT INTO gaming_user_profiles (user_id, trivia_streak_days")) {
    const cur = fake.profiles.get(String(p[0])) ?? { xp: 0, level: 1, streak: 0, lastDay: null };
    cur.streak = Number(p[1]);
    cur.lastDay = new Date().toISOString().slice(0, 10);
    fake.profiles.set(String(p[0]), cur);
    return res();
  }
  if (sql.includes("FROM gaming_user_profiles WHERE user_id = $1")) {
    const cur = fake.profiles.get(String(p[0]));
    return res(cur ? [{ user_id: p[0], xp_points: String(cur.xp), trivia_streak_days: cur.streak }] : []);
  }
  if (sql.includes("UPDATE gaming_game_sessions")) return res(fake.sessions.length ? [fake.sessions.shift() as Row] : []);
  if (sql.includes("UPDATE gaming_trivia_rounds") && sql.includes("used_at = now()")) return res(fake.rounds.length ? [fake.rounds.shift() as Row] : []);
  if (sql.includes("INSERT INTO gaming_trivia_rounds")) return res([{ id: `round-new-${++seq}` }]);
  if (sql.includes("INSERT INTO gaming_scores")) {
    fake.scores.push(p);
    return res();
  }
  if (sql.includes("AS views_today")) return res([{ ...fake.activity }]);
  return res();
}

export async function withTransaction<T>(fn: (q: typeof dbQuery) => Promise<T>): Promise<T> {
  return fn(dbQuery);
}

export const dbModule = { dbQuery, withTransaction };
