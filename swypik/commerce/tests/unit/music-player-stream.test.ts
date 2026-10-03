import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planPreconnect, streamCandidates, streamOrigins } from "@/lib/music/player/stream-hosts";
import { createStreamFallback, initStreamFallback, reduceStreamFallback, startStreamFallback } from "@/lib/music/player/stream-fallback";
import { artworkMimeType, buildMediaMetadata, mediaSessionActions } from "@/lib/music/player/media-session";
import { buildSilentWavBytes, isSilentPrimerSrc, silentWavDataUri } from "@/lib/music/player/silent-audio";
import { audioItemToTrackDto, type AudioItemDto } from "@/lib/audio/types";

describe("music/player streamCandidates", () => {
  it("pune URL-ul principal primul și deduplică alternativele", () => {
    expect(
      streamCandidates({
        streamUrl: "https://a.example/live",
        streamUrlFallbacks: ["https://a.example/live", "https://b.example/live", "https://b.example/live"],
      }),
    ).toEqual(["https://a.example/live", "https://b.example/live"]);
  });

  it("acceptă alternative doar pe https și ignoră URL-urile invalide", () => {
    expect(
      streamCandidates({ streamUrl: "https://a.example/s", streamUrlFallbacks: ["http://b.example/s", "nu e url", " https://c.example/s "] }),
    ).toEqual(["https://a.example/s", "https://c.example/s"]);
  });

  it("limitează numărul de candidați și suportă lipsa URL-ului principal", () => {
    const fallbacks = ["https://1.x/a", "https://2.x/a", "https://3.x/a", "https://4.x/a", "https://5.x/a"];
    expect(streamCandidates({ streamUrl: "https://0.x/a", streamUrlFallbacks: fallbacks }, 3)).toHaveLength(3);
    expect(streamCandidates({ streamUrlFallbacks: ["https://1.x/a"] })).toEqual(["https://1.x/a"]);
    expect(streamCandidates({})).toEqual([]);
  });
});

describe("music/player streamOrigins + planPreconnect", () => {
  it("extrage origin-uri distincte, fără origin-ul paginii", () => {
    expect(
      streamOrigins(["https://a.example:8443/x", "https://a.example:8443/y", "https://swypik.com/api", "ftp://z.example/f", "rău"], "https://swypik.com"),
    ).toEqual(["https://a.example:8443"]);
  });

  it("adaugă origin-uri noi și evacuează cele mai vechi peste limită (LRU)", () => {
    const plan = planPreconnect(["https://a", "https://b", "https://c"], ["https://d", "https://e"], 4);
    expect(plan.next).toEqual(["https://b", "https://c", "https://d", "https://e"]);
    expect(plan.add).toEqual(["https://d", "https://e"]);
    expect(plan.remove).toEqual(["https://a"]);
  });

  it("un origin deja activ doar urcă în LRU, fără tag nou", () => {
    const plan = planPreconnect(["https://a", "https://b"], ["https://a"], 4);
    expect(plan.next).toEqual(["https://b", "https://a"]);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("limita 0 nu păstrează nimic", () => {
    expect(planPreconnect(["https://a"], ["https://b"], 0)).toEqual({ next: [], add: [], remove: ["https://a"] });
  });
});

describe("music/player reduceStreamFallback", () => {
  const urls = ["https://a/1", "https://b/2"];

  it("start încearcă primul URL; playing marchează pornirea", () => {
    const s0 = startStreamFallback(initStreamFallback(urls));
    expect(s0.action).toEqual({ type: "try", url: "https://a/1" });
    const s1 = reduceStreamFallback(s0.state, { type: "playing" });
    expect(s1.action).toEqual({ type: "started" });
    expect(reduceStreamFallback(s1.state, { type: "stalled" }).action).toEqual({ type: "none" });
  });

  it("stalled/error înainte de pornire trec la următorul URL, apoi fail", () => {
    const s0 = startStreamFallback(initStreamFallback(urls));
    const s1 = reduceStreamFallback(s0.state, { type: "stalled" });
    expect(s1.action).toEqual({ type: "try", url: "https://b/2" });
    const s2 = reduceStreamFallback(s1.state, { type: "error" });
    expect(s2.action).toEqual({ type: "fail" });
    expect(s2.state.failed).toBe(true);
    expect(reduceStreamFallback(s2.state, { type: "error" }).action).toEqual({ type: "none" });
  });

  it("pauza/autoplay blocat dezarmează timerul; play îl rearmează", () => {
    const s0 = startStreamFallback(initStreamFallback(urls));
    const idle = reduceStreamFallback(s0.state, { type: "idle" });
    expect(idle.action).toEqual({ type: "disarm" });
    expect(reduceStreamFallback(idle.state, { type: "timeout" }).action).toEqual({ type: "none" });
    expect(reduceStreamFallback(idle.state, { type: "play" }).action).toEqual({ type: "arm" });
  });

  it("fără URL-uri: start raportează direct fail", () => {
    expect(startStreamFallback(initStreamFallback([])).action).toEqual({ type: "fail" });
  });
});

describe("music/player createStreamFallback (timer)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(urls: string[]) {
    const tried: string[] = [];
    const onStarted = vi.fn();
    const onFail = vi.fn();
    const ctrl = createStreamFallback(urls, 4000, { onTry: (u) => tried.push(u), onStarted, onFail });
    return { ctrl, tried, onStarted, onFail };
  }

  it("apelează onTry sincron la start (păstrează gestul userului)", () => {
    const { ctrl, tried } = setup(["https://a/1"]);
    ctrl.start();
    expect(tried).toEqual(["https://a/1"]);
  });

  it("timeout fără playing → URL-ul următor; după toate → onFail", () => {
    const { ctrl, tried, onFail } = setup(["https://a/1", "https://b/2"]);
    ctrl.start();
    vi.advanceTimersByTime(3999);
    expect(tried).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(tried).toEqual(["https://a/1", "https://b/2"]);
    vi.advanceTimersByTime(4000);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("playing la timp oprește timerul și nu mai schimbă URL-ul", () => {
    const { ctrl, tried, onStarted, onFail } = setup(["https://a/1", "https://b/2"]);
    ctrl.start();
    vi.advanceTimersByTime(2000);
    ctrl.handle({ type: "playing" });
    vi.advanceTimersByTime(20_000);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(tried).toEqual(["https://a/1"]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("error după pornire (flux live căzut) reconectează la următorul URL", () => {
    const { ctrl, tried } = setup(["https://a/1", "https://b/2"]);
    ctrl.start();
    ctrl.handle({ type: "playing" });
    ctrl.handle({ type: "error" });
    expect(tried).toEqual(["https://a/1", "https://b/2"]);
  });

  it("dispose oprește orice tranziție ulterioară", () => {
    const { ctrl, tried, onFail } = setup(["https://a/1", "https://b/2"]);
    ctrl.start();
    ctrl.dispose();
    vi.advanceTimersByTime(10_000);
    ctrl.handle({ type: "error" });
    expect(tried).toEqual(["https://a/1"]);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe("music/player media session", () => {
  const labels = { liveAlbum: "Radio live", defaultAlbum: "Swypik Music" };
  const base = { title: "Piesa", coverUrl: "https://cdn.x/c.png?v=1", genre: "pop", isLive: false, artist: { stageName: "Artist" } };

  it("construiește metadatele cu copertă și tip MIME", () => {
    expect(buildMediaMetadata(base, labels)).toEqual({
      title: "Piesa",
      artist: "Artist",
      album: "pop",
      artwork: [{ src: "https://cdn.x/c.png?v=1", sizes: "512x512", type: "image/png" }],
    });
  });

  it("radio live folosește eticheta tradusă; fără copertă → artwork gol; fără gen → album implicit", () => {
    expect(buildMediaMetadata({ ...base, isLive: true }, labels).album).toBe("Radio live");
    expect(buildMediaMetadata({ ...base, coverUrl: null, genre: "" }, labels)).toMatchObject({ artwork: [], album: "Swypik Music" });
    expect(buildMediaMetadata({ ...base, coverUrl: "https://cdn.x/cover" }, labels).artwork[0]).not.toHaveProperty("type");
  });

  it("seek doar pentru conținut non-live", () => {
    expect(mediaSessionActions(true)).toEqual(["play", "pause", "stop", "nexttrack", "previoustrack"]);
    expect(mediaSessionActions(false)).toContain("seekto");
    expect(artworkMimeType("https://a/b.JPG")).toBe("image/jpeg");
  });
});

describe("music/player silent primer + contract DTO", () => {
  it("clipul mut e un WAV valid, redat din data URI", () => {
    const bytes = buildSilentWavBytes(10, 8000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(bytes).toHaveLength(54);
    expect(silentWavDataUri().startsWith("data:audio/wav;base64,")).toBe(true);
    expect(isSilentPrimerSrc(silentWavDataUri())).toBe(true);
    expect(isSilentPrimerSrc("https://a/x.mp3")).toBe(false);
    expect(isSilentPrimerSrc(null)).toBe(false);
  });

  it("audioItemToTrackDto copiază streamUrlFallbacks", () => {
    const item: AudioItemDto = {
      id: "r1", slug: "r1", title: "Radio", artist: "Radio", coverUrl: null, streamUrl: "https://a/live",
      streamUrlFallbacks: ["https://b/live"], durationMs: 0, genre: "radio", source: "radio", isLive: true,
    };
    expect(audioItemToTrackDto(item).streamUrlFallbacks).toEqual(["https://b/live"]);
  });
});
