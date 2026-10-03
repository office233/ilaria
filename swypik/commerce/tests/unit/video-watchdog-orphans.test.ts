import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("video watchdog orphan cleanup", () => {
  it("fails stale uploading rows only when no job or resumable upload is active", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/cron/watchdog-videos/route.ts"),
      "utf8",
    );
    expect(source).toContain("v.status = 'uploading'");
    expect(source).toContain("INTERVAL '6 hours'");
    expect(source).toContain("NOT EXISTS (SELECT 1 FROM video_processing_jobs");
    expect(source).toContain("video_upload_sessions");
    expect(source).toContain("s.expires_at > NOW()");
    expect(source).toContain("visibility='private'");
    expect(source).toContain("is_hidden=true");
    expect(source).toContain("expireAbandonedUploads()");
  });
});
