import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, stubs = {}) {
  const sourcePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in stubs) return stubs[id];
    return require(id);
  };

  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
  });

  return module.exports;
}

function createProfileModule(query) {
  return loadTsModule("lib/social/user-profile.ts", {
    "@/lib/db": { dbQuery: query },
  });
}

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("getPublicUserProfile returns an active user by username with stats and public videos", async () => {
  const calls = [];
  const viewerUserId = "00000000-0000-4000-8000-000000000099";
  const targetUserId = "00000000-0000-4000-8000-000000000123";

  const query = async (sql, params = []) => {
    calls.push({ sql, params });

    if (sql.includes("FROM users u")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: targetUserId,
            username: "Ana.Shop",
            display_name: "Ana Shop",
            avatar_url: "https://cdn.example/avatar.jpg",
            bio: "Curated daily finds.",
            is_verified: true,
            video_count: "2",
            follower_count: "12",
            following_count: "3",
            total_views: "1500",
            total_likes: "77",
            total_comments: "5",
            is_following: true,
          },
        ],
      };
    }

    if (sql.includes("FROM videos v")) {
      assert.match(sql, /v\.status\s+=\s+'ready'/);
      assert.match(sql, /v\.visibility\s+=\s+'public'/);
      return {
        rowCount: 2,
        rows: [
          {
            id: "video-2",
            title: "Second clip",
            description: "Newest",
            thumbnail_url: "https://cdn.example/thumb-2.jpg",
            playback_url: "https://cdn.example/video-2.mp4",
            duration_ms: 123000,
            view_count: "1000",
            like_count: "50",
            comment_count: "4",
            save_count: "8",
            share_count: "2",
            published_at: "2026-05-12T10:00:00.000Z",
          },
          {
            id: "video-1",
            title: "First clip",
            description: null,
            thumbnail_url: null,
            playback_url: "https://cdn.example/video-1.mp4",
            duration_ms: null,
            view_count: 500,
            like_count: 27,
            comment_count: 1,
            save_count: 0,
            share_count: 0,
            published_at: null,
          },
        ],
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const { getPublicUserProfile } = createProfileModule(query);
  const result = await getPublicUserProfile("@Ana.Shop", {
    viewerUserId,
    limit: 12,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params[0], "ana.shop");
  assert.equal(calls[0].params[1], viewerUserId);
  assert.match(calls[0].sql, /lower\(u\.username\)\s+=\s+\$1/);
  assert.match(calls[0].sql, /u\.status\s+=\s+'active'/);
  assert.equal(calls[1].params[0], targetUserId);
  assert.equal(calls[1].params[1], 12);

  assert.equal(result.profile.id, targetUserId);
  assert.equal(result.profile.username, "Ana.Shop");
  assert.equal(result.profile.handle, "@Ana.Shop");
  assert.equal(result.profile.displayName, "Ana Shop");
  assert.equal(result.profile.isVerified, true);
  assert.equal(result.profile.isFollowing, true);
  assert.equal(result.profile.isOwnProfile, false);
  assertJsonEqual(result.stats, {
    videos: 2,
    followers: 12,
    following: 3,
    views: 1500,
    likes: 77,
    comments: 5,
  });
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos[0].durationMs, 123000);
  assert.equal(result.videos[1].publishedAt, null);
});

test("getPublicUserProfile marks own profile and ignores invalid viewer ids", async () => {
  const calls = [];
  const targetUserId = "00000000-0000-4000-8000-000000000123";

  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("FROM users u")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: targetUserId,
            username: "ana",
            display_name: null,
            avatar_url: null,
            bio: null,
            is_verified: false,
            video_count: "0",
            follower_count: "0",
            following_count: "0",
            total_views: "0",
            total_likes: "0",
            total_comments: "0",
            is_following: false,
          },
        ],
      };
    }
    if (sql.includes("FROM videos v")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const { getPublicUserProfile } = createProfileModule(query);
  const own = await getPublicUserProfile("ana", {
    viewerUserId: targetUserId,
  });
  const anonymous = await getPublicUserProfile("ana", {
    viewerUserId: "not-a-uuid-session-token",
  });

  assert.equal(own.profile.isOwnProfile, true);
  assert.equal(own.profile.isFollowing, false);
  assert.equal(anonymous.profile.isOwnProfile, false);
  assert.equal(calls[2].params[1], null);
});

test("getPublicUserProfile returns null for missing or invalid usernames", async () => {
  let queryCount = 0;
  const { getPublicUserProfile } = createProfileModule(async () => {
    queryCount += 1;
    return { rowCount: 0, rows: [] };
  });

  assert.equal(await getPublicUserProfile("!!!"), null);
  assert.equal(queryCount, 0);

  assert.equal(await getPublicUserProfile("missing-user"), null);
  assert.equal(queryCount, 1);
});
