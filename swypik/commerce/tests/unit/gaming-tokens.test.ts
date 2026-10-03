import { describe, it, expect } from "vitest";
import { issueGamingToken, verifyGamingToken, hashToken } from "@/lib/gaming/tokens";

describe("gaming/tokens", () => {
  it("round-trips a valid token", () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    const payload = verifyGamingToken(token, "session");
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe("user-1");
    expect(payload?.ref).toBe("game_2048");
    expect(payload?.kind).toBe("session");
  });

  it("rejects a tampered payload", () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    const [b64, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    decoded.userId = "attacker";
    const tamperedB64 = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    const tampered = `${tamperedB64}.${sig}`;
    expect(verifyGamingToken(tampered, "session")).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = issueGamingToken("session", "user-1", "game_2048", 600);
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyGamingToken(tampered, "session")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = issueGamingToken("session", "user-1", "game_2048", -1);
    expect(verifyGamingToken(token, "session")).toBeNull();
  });

  it("rejects a token verified under the wrong kind", () => {
    const token = issueGamingToken("trivia", "user-1", "round-1", 600);
    expect(verifyGamingToken(token, "session")).toBeNull();
    expect(verifyGamingToken(token, "trivia")).not.toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    expect(verifyGamingToken(null, "session")).toBeNull();
    expect(verifyGamingToken(undefined, "session")).toBeNull();
    expect(verifyGamingToken("", "session")).toBeNull();
    expect(verifyGamingToken("not-a-token", "session")).toBeNull();
    expect(verifyGamingToken("abc.def", "session")).toBeNull();
  });

  it("hashToken is deterministic and distinguishes different tokens", () => {
    const a = issueGamingToken("session", "user-1", "game_2048", 600);
    const b = issueGamingToken("session", "user-1", "game_2048", 600);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b)); // different nonce/iat
  });
});
