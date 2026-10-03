import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Explore unauthenticated action UX", () => {
  it("redirects save to login on 401 and follow through the shared auth redirect", () => {
    const toggle = read("components/explore/actions/useToggleAction.ts");
    const follow = read("components/social/FollowButton.tsx");
    const like = read("components/social/LikeButton.tsx");

    expect(toggle).toContain('res.status === 401');
    expect(toggle).toContain('/auth/login?next=');
    expect(follow).toContain("useAuthRedirect");
    expect(follow).toContain('reason === "unauthorized"');
    expect(like).toContain("Merge și pentru vizitatori anonimi");
  });
});
