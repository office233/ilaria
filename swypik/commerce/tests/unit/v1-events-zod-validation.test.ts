import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/social/proxy", () => ({
  getSocialApiBaseUrl: () => null,
}));

import { normalizeBatchPayload } from "@/app/api/v1/events/compat";

const VIDEO = "11111111-1111-4111-8111-111111111111";

describe("legacy /v1/events Zod compatibility contract", () => {
  it("keeps supported legacy aliases while normalizing the event", () => {
    const batch = normalizeBatchPayload({
      sessionId: "legacy-session",
      events: [{
        eventType: "view",
        subjectType: "video",
        subjectId: VIDEO,
        metadata: { source: "legacy" },
      }],
    });
    expect(batch).not.toBeNull();
    expect(batch?.events[0]).toMatchObject({
      type: "video_impression",
      subject_type: "video",
      subject_id: VIDEO,
    });
  });

  it("rejects batches above the public limit instead of partially accepting them", () => {
    const events = Array.from({ length: 51 }, () => ({
      type: "video_impression",
      subject_type: "video",
      subject_id: VIDEO,
    }));
    expect(normalizeBatchPayload({ events })).toBeNull();
  });

  it("rejects oversized metadata before normalization/proxying", () => {
    expect(normalizeBatchPayload({
      events: [{
        type: "video_impression",
        subject_type: "video",
        subject_id: VIDEO,
        metadata: { blob: "x".repeat(20_000) },
      }],
    })).toBeNull();
  });

  it("rejects malformed events instead of silently dropping only the bad row", () => {
    expect(normalizeBatchPayload({
      events: [
        {
          type: "video_impression",
          subject_type: "video",
          subject_id: VIDEO,
        },
        {
          type: "x".repeat(100),
          subject_type: "video",
          subject_id: VIDEO,
        },
      ],
    })).toBeNull();
  });
});
