import { beforeEach, describe, expect, it, vi } from "vitest";

// Ruta rulată de cron-worker-ul de pe Azure (web-1) la 5 minute: POST + Bearer CRON_SECRET.
const runStaysLifecycle = vi.fn();
vi.mock("@/lib/stays/lifecycle", () => ({ runStaysLifecycle: () => runStaysLifecycle() }));
let lockHeld = false;
vi.mock("@/lib/cron/runCron", () => ({
    runCron: async (_name: string, fn: () => Promise<unknown>) => (lockHeld ? null : fn()),
    cronSkippedResponse: (name: string) => Response.json({ skipped: true, job: name }),
}));

import { GET, POST } from "@/app/api/cron/stays-lifecycle/route";

const req = (auth?: string) => new Request("http://x/api/cron/stays-lifecycle", { method: "POST", headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
    vi.clearAllMocks();
    lockHeld = false;
    process.env.CRON_SECRET = "cron-secret-value";
    runStaysLifecycle.mockResolvedValue({ expiredPending: 0, expiredRequests: 0, completed: 0, errors: 0 });
});

describe("POST /api/cron/stays-lifecycle", () => {
    it("rejects missing or wrong secrets without running the job", async () => {
        expect((await POST(req())).status).toBe(401);
        expect((await POST(req("Bearer wrong"))).status).toBe(401);
        expect(runStaysLifecycle).not.toHaveBeenCalled();
    });

    it("runs the job with the cron-worker's Bearer secret (GET and POST)", async () => {
        const res = await POST(req("Bearer cron-secret-value"));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, expiredRequests: 0 });
        expect((await GET(req("Bearer cron-secret-value"))).status).toBe(200);
    });

    it("a repeated/overlapping trigger is a harmless no-op (advisory lock → skipped)", async () => {
        lockHeld = true;
        const res = await POST(req("Bearer cron-secret-value"));
        expect(await res.json()).toMatchObject({ skipped: true });
        expect(runStaysLifecycle).not.toHaveBeenCalled();
    });
});
