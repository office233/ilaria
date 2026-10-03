import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("camera unavailable fallback", () => {
  it("offers the gallery for both denied and unavailable camera states", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/upload/CameraCapture.tsx"),
      "utf8",
    );
    expect(source).toContain('camera.status === "denied" || camera.status === "unavailable"');
    expect(source).toContain("onClick={props.onGallery}");
    expect(source).toContain('t("useGallery")');
  });
});
