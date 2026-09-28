import { describe, it, expect } from "vitest";
import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";
import { hintIndexes, isConstrainedNetwork, isHlsUrl, posterWidth, slotState } from "@/lib/video/feed-preload";
import { hlsBufferConfig, hlsConfig } from "@/lib/video/hls-config";

describe("slotState — player atașat doar pentru activ ±1", () => {
  it("activ, vecini preîncărcați, restul idle", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => slotState(i, 2, false))).toEqual(["idle", "preload", "active", "preload", "idle", "idle"]);
  });

  it("primul slide: fără vecin anterior", () => {
    expect([0, 1, 2].map((i) => slotState(i, 0, false))).toEqual(["active", "preload", "idle"]);
  });

  it("rețea economică: doar clipul activ are player", () => {
    expect([1, 2, 3].map((i) => slotState(i, 2, true))).toEqual(["idle", "active", "idle"]);
  });
});

describe("hintIndexes — prefetch manifest/poster pentru următoarele 2, fără player", () => {
  it("după vecinul atașat rămâne doar activ+2", () => {
    expect(hintIndexes(0, 10, false)).toEqual([2]);
    expect(hintIndexes(5, 10, false)).toEqual([7]);
  });

  it("nu depășește finalul listei", () => {
    expect(hintIndexes(8, 10, false)).toEqual([]);
    expect(hintIndexes(9, 10, false)).toEqual([]);
  });

  it("rețea economică: nimic", () => {
    expect(hintIndexes(0, 10, true)).toEqual([]);
  });
});

describe("isConstrainedNetwork", () => {
  it("Data Saver sau 2G → constrâns", () => {
    expect(isConstrainedNetwork({ saveData: true, effectiveType: "4g" })).toBe(true);
    expect(isConstrainedNetwork({ effectiveType: "2g" })).toBe(true);
    expect(isConstrainedNetwork({ effectiveType: "slow-2g" })).toBe(true);
  });

  it("3g/4g sau API lipsă → normal", () => {
    expect(isConstrainedNetwork({ saveData: false, effectiveType: "4g" })).toBe(false);
    expect(isConstrainedNetwork({ effectiveType: "3g" })).toBe(false);
    expect(isConstrainedNetwork(undefined)).toBe(false);
    expect(isConstrainedNetwork(null)).toBe(false);
  });
});

describe("posterWidth", () => {
  it("rotunjește în sus la lățimile configurate (pixeli fizici)", () => {
    expect(posterWidth(390, 3)).toBe(1280);
    expect(posterWidth(360, 2)).toBe(750);
    expect(posterWidth(360, 1)).toBe(360);
  });

  it("plafonat la cea mai mare lățime; valori invalide → implicit", () => {
    expect(posterWidth(2560, 2)).toBe(1920);
    expect(posterWidth(0, 2)).toBe(VIDEO_PLAYBACK.defaultPosterWidth);
    expect(posterWidth(400, Number.NaN)).toBe(480);
  });
});

describe("isHlsUrl", () => {
  it("recunoaște .m3u8 cu sau fără query", () => {
    expect(isHlsUrl("https://m.test/v/master.m3u8")).toBe(true);
    expect(isHlsUrl("https://m.test/v/master.m3u8?t=1")).toBe(true);
    expect(isHlsUrl("https://m.test/v/preview.mp4")).toBe(false);
  });
});

describe("hlsConfig — o singură configurație pentru toate playerele", () => {
  it("ABR automat de la o estimare conservatoare, plafonat la mărimea playerului", () => {
    const cfg = hlsConfig();
    expect(cfg.startLevel).toBe(-1);
    expect(cfg.capLevelToPlayerSize).toBe(true);
    expect(cfg.abrEwmaDefaultEstimate).toBe(VIDEO_PLAYBACK.initialBandwidthBps);
    expect(cfg.maxBufferLength).toBe(VIDEO_PLAYBACK.activeBuffer.maxBufferLength);
  });

  it("vecinul preîncărcat are buffer mic", () => {
    const preload = hlsConfig("preload");
    expect(preload.maxBufferLength).toBeLessThan(hlsConfig("active").maxBufferLength ?? 0);
    expect(hlsBufferConfig("preload")).toEqual(VIDEO_PLAYBACK.preloadBuffer);
  });

  it("returnează copii (mutarea hls.config nu atinge constantele)", () => {
    const buf = hlsBufferConfig("active");
    buf.maxBufferLength = 999;
    expect(VIDEO_PLAYBACK.activeBuffer.maxBufferLength).not.toBe(999);
  });
});
