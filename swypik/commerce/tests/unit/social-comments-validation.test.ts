import { describe, expect, it } from "vitest";
import { validateCommentText } from "@/lib/social/comments";

/**
 * Audit 2026-09-24 (wave2-misc): validateCommentText used to return hardcoded
 * English sentences ("Comment text is required" / "... 500 characters or
 * less") that app/api/videos/[id]/comments/route.ts passed straight through
 * as `{ error }`, and components/social/CommentsSheet.tsx displayed raw to
 * every locale. It now returns a stable `code` only; the route forwards the
 * code, and the client translates it (see translateApiError in
 * CommentsSheet.tsx).
 */
describe("validateCommentText — stable error codes", () => {
  it("returns comment_text_required for non-string input", () => {
    const result = validateCommentText(undefined);
    expect(result).toEqual({ ok: false, code: "comment_text_required" });
  });

  it("returns comment_text_required for whitespace-only input", () => {
    const result = validateCommentText("    ");
    expect(result).toEqual({ ok: false, code: "comment_text_required" });
  });

  it("returns comment_text_too_long for text over 500 chars", () => {
    const result = validateCommentText("x".repeat(501));
    expect(result).toEqual({ ok: false, code: "comment_text_too_long" });
  });

  it("never leaks a literal human-readable message on failure", () => {
    for (const input of [undefined, null, 42, "   ", "x".repeat(600)]) {
      const result = validateCommentText(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as unknown as { error?: string }).error).toBeUndefined();
        expect(result.code).not.toMatch(/\s/);
      }
    }
  });

  it("normalizes whitespace and accepts valid text", () => {
    const result = validateCommentText("  Salut   lume  ");
    expect(result).toEqual({ ok: true, text: "Salut lume" });
  });
});
