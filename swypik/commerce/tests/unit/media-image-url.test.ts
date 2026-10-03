import { describe, it, expect, afterEach, vi } from "vitest";
import mediaImageLoader, { mediaImageUrl } from "@/lib/storage/image-loader";

const BASE = "https://media.example.test";

function transformOn() {
  vi.stubEnv("NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL", `${BASE}/`);
  vi.stubEnv("NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM", "cloudflare");
}

afterEach(() => vi.unstubAllEnvs());

describe("mediaImageUrl — postere / thumbnail-uri pentru <img> și <video poster>", () => {
  it("transformări active: imaginea de pe CDN trece prin /cdn-cgi/image cu format=auto", () => {
    transformOn();
    expect(mediaImageUrl(`${BASE}/v/1/thumb.jpg`, 828, 70)).toBe(`${BASE}/cdn-cgi/image/width=828,quality=70,format=auto/v/1/thumb.jpg`);
  });

  it("calitatea implicită și lățimea rotunjită", () => {
    transformOn();
    expect(mediaImageUrl(`${BASE}/a.jpg`, 640.4)).toBe(`${BASE}/cdn-cgi/image/width=640,quality=75,format=auto/a.jpg`);
  });

  it("transformări oprite: URL-ul rămâne neschimbat", () => {
    vi.stubEnv("NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM", "");
    expect(mediaImageUrl(`${BASE}/a.jpg`, 640)).toBe(`${BASE}/a.jpg`);
  });

  it("gazdă din afara CDN-ului media: neatinsă", () => {
    transformOn();
    expect(mediaImageUrl("https://images.other.test/a.jpg", 640)).toBe("https://images.other.test/a.jpg");
    // prefix înșelător (alt domeniu care începe la fel)
    expect(mediaImageUrl(`${BASE}.evil.test/a.jpg`, 640)).toBe(`${BASE}.evil.test/a.jpg`);
  });

  it("cale relativă: neschimbată (fără ?w=, care servește doar srcset-ului next/image)", () => {
    transformOn();
    expect(mediaImageUrl("/brand/poster.jpg", 640)).toBe("/brand/poster.jpg");
  });

  it("loader-ul implicit pentru next/image funcționează în continuare", () => {
    transformOn();
    expect(mediaImageLoader({ src: `${BASE}/p/a.jpg`, width: 640, quality: 60 })).toBe(`${BASE}/cdn-cgi/image/width=640,quality=60,format=auto/p/a.jpg`);
    expect(mediaImageLoader({ src: "/brand/logo.png", width: 96 })).toBe("/brand/logo.png?w=96");
  });
});
