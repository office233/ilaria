import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath) {
  const sourcePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require,
    console,
  });

  return module.exports;
}

const {
  chooseCommentStatus,
  mapCommentRow,
  validateCommentText,
} = loadTsModule("lib/social/comments.ts");

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

assertJsonEqual(validateCommentText("  Salut   lume  "), {
  ok: true,
  text: "Salut lume",
});

assertJsonEqual(validateCommentText("    "), {
  ok: false,
  code: "comment_text_required",
});

assertJsonEqual(validateCommentText("x".repeat(501)), {
  ok: false,
  code: "comment_text_too_long",
});

assert.equal(chooseCommentStatus("produs fake scam"), "flagged");
assert.equal(chooseCommentStatus("Imi place produsul"), "visible");

assertJsonEqual(
  mapCommentRow({
    id: "comment-1",
    video_id: "video-1",
    user_id: "user-1",
    parent_comment_id: null,
    body: "Salut lume",
    status: "visible",
    like_count: "2",
    reply_count: "1",
    created_at: new Date("2026-05-12T10:00:00.000Z"),
    username: "ana",
    display_name: "Ana",
    avatar_url: null,
  }),
  {
    id: "comment-1",
    videoId: "video-1",
    userId: "user-1",
    parentCommentId: null,
    text: "Salut lume",
    status: "visible",
    likeCount: 2,
    replyCount: 1,
    createdAt: "2026-05-12T10:00:00.000Z",
    author: {
      id: "user-1",
      username: "ana",
      displayName: "Ana",
      avatarUrl: null,
    },
    replies: [],
  },
);
