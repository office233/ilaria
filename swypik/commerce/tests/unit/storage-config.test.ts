import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mediaCspOrigins,
  mediaPublicBaseUrl,
  mediaPublicUrl,
  objectKeyFromMediaUrl,
  readStorageSettings,
} from "@/lib/storage/config";
import mediaImageLoader from "@/lib/storage/image-loader";

const KEYS = [
  "MEDIA_PUBLIC_BASE_URL", "S3_PUBLIC_URL", "S3_PUBLIC_BASE_URL", "R2_PUBLIC_URL", "R2_PUBLIC_BASE_URL",
  "S3_ENDPOINT", "S3_ENDPOINT_URL", "R2_ENDPOINT", "R2_ENDPOINT_URL", "S3_BUCKET", "S3_MEDIA_BUCKET", "R2_BUCKET",
  "S3_ACCESS_KEY", "S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID",
  "S3_SECRET_KEY", "S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY",
  "S3_REGION", "R2_REGION", "AWS_REGION", "S3_PRESIGN_ENDPOINT", "S3_UPLOAD_PUBLIC_ENDPOINT", "MEDIA_SIGNED_BASE_URL",
  "NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL", "NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM",
];

beforeEach(() => {
  for (const k of KEYS) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("lib/storage/config — un singur modul pentru MinIO și R2", () => {
  it("MEDIA_PUBLIC_BASE_URL are prioritate față de alias-urile vechi și pierde `/` final", () => {
    vi.stubEnv("S3_PUBLIC_URL", "https://legacy.example.test");
    vi.stubEnv("MEDIA_PUBLIC_BASE_URL", "https://media.example.test/");
    expect(mediaPublicBaseUrl()).toBe("https://media.example.test");
    expect(mediaPublicUrl("/videos/a.jpg")).toBe("https://media.example.test/videos/a.jpg");
  });

  it("fără CDN configurat, cade pe endpoint/bucket (MinIO path style); altfel șir gol", () => {
    expect(mediaPublicBaseUrl()).toBe("");
    vi.stubEnv("S3_ENDPOINT", "http://localhost:9000/");
    vi.stubEnv("S3_BUCKET", "video");
    expect(mediaPublicBaseUrl()).toBe("http://localhost:9000/video");
  });

  it("readStorageSettings: null până când endpoint, bucket și cheile există; R2 → region auto", () => {
    expect(readStorageSettings()).toBeNull();
    vi.stubEnv("S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com");
    vi.stubEnv("S3_BUCKET", "swypik-media");
    vi.stubEnv("S3_ACCESS_KEY", "ak");
    expect(readStorageSettings()).toBeNull();
    vi.stubEnv("S3_SECRET_KEY", "sk");
    expect(readStorageSettings()).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "swypik-media",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      presignEndpoint: "https://acct.r2.cloudflarestorage.com",
    });
    vi.stubEnv("S3_UPLOAD_PUBLIC_ENDPOINT", "https://cdn.example.test");
    expect(readStorageSettings()?.presignEndpoint).toBe("https://cdn.example.test");
  });

  it("objectKeyFromMediaUrl: doar URL-uri din baza noastră, fără traversare", () => {
    vi.stubEnv("MEDIA_PUBLIC_BASE_URL", "https://media.example.test");
    expect(objectKeyFromMediaUrl("https://media.example.test/private/v/x/master.m3u8?t=1")).toBe("private/v/x/master.m3u8");
    expect(objectKeyFromMediaUrl("https://media.example.test/a/%20b.jpg")).toBe("a/ b.jpg");
    expect(objectKeyFromMediaUrl("https://other.example.test/a.jpg")).toBeNull();
    expect(objectKeyFromMediaUrl("https://media.example.test/a/../b")).toBeNull();
    expect(objectKeyFromMediaUrl("https://media.example.test/%E0%A4%A")).toBeNull();
  });

  it("mediaCspOrigins: CDN + URL-uri semnate + endpoint de upload, doar https, fără duplicate", () => {
    vi.stubEnv("MEDIA_PUBLIC_BASE_URL", "https://media.example.test/x");
    vi.stubEnv("MEDIA_SIGNED_BASE_URL", "https://media.example.test");
    vi.stubEnv("S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com");
    expect(mediaCspOrigins()).toEqual(["https://media.example.test", "https://acct.r2.cloudflarestorage.com"]);
    vi.stubEnv("S3_ENDPOINT", "http://localhost:9000");
    expect(mediaCspOrigins()).toEqual(["https://media.example.test"]);
  });
});

describe("lib/storage/image-loader — imaginile nu trec prin serverul aplicației", () => {
  it("URL-urile absolute rămân neschimbate (browserul le ia direct de pe CDN)", () => {
    expect(mediaImageLoader({ src: "https://media.example.test/a.jpg", width: 640 })).toBe("https://media.example.test/a.jpg");
  });

  it("cu transformări Cloudflare active, imaginile de pe CDN primesc /cdn-cgi/image", () => {
    vi.stubEnv("NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL", "https://media.example.test/");
    vi.stubEnv("NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM", "cloudflare");
    expect(mediaImageLoader({ src: "https://media.example.test/p/a.jpg", width: 640, quality: 60 }))
      .toBe("https://media.example.test/cdn-cgi/image/width=640,quality=60,format=auto/p/a.jpg");
    expect(mediaImageLoader({ src: "https://images.other.test/a.jpg", width: 640 })).toBe("https://images.other.test/a.jpg");
  });

  it("fișierele locale primesc lățimea doar ca parametru (srcset)", () => {
    expect(mediaImageLoader({ src: "/brand/logo.png", width: 96 })).toBe("/brand/logo.png?w=96");
    expect(mediaImageLoader({ src: "/a.png?v=2", width: 96 })).toBe("/a.png?v=2&w=96");
  });
});
