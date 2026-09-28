/**
 * Mix like/comentariu pe clipuri (contul de test, doar staging).
 *   Mereu:            GET /api/videos/<id>/like, GET /api/videos/<id>/comments?limit=20
 *   ALLOW_WRITES=1:   PUT + DELETE /api/videos/<id>/like (efect net zero) și, cu
 *                     probabilitatea COMMENT_RATIO (implicit 0.1), POST un comentariu
 *                     { text } urmat de DELETE ?comment_id=… (curățenie).
 * Fără ALLOW_WRITES scenariul rămâne read-only. Scrierile cer SESSION_COOKIE.
 * Comentariile trec prin moderarea AI (Azure Content Safety) → cost real per cerere.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke -e ALLOW_WRITES=1 \
 *          -e SESSION_COOKIE=<token> tests/load/k6/social-writes.js
 */
import { check, sleep } from "k6";
import { buildOptions, ALLOW_WRITES, requireWritesAllowed } from "./lib/config.js";
import { get, send, json, checkJson } from "./lib/http.js";
import { discoverVideoIds, pick } from "./lib/discover.js";

const COMMENT_RATIO = Math.min(1, Math.max(0, Number(__ENV.COMMENT_RATIO ?? 0.1)));

export const options = buildOptions({
  like_get: { p95: 400, p99: 900 },
  comments_list: { p95: 700, p99: 1500 },
  like_put: { p95: 600, p99: 1200 },
  like_delete: { p95: 600, p99: 1200 },
  comment_post: { p95: 1500, p99: 3000 },
  comment_delete: { p95: 600, p99: 1200 },
});

export function setup() {
  if (ALLOW_WRITES) requireWritesAllowed();
  const ids = discoverVideoIds(30);
  if (!ids.length) throw new Error("Niciun clip găsit: setează -e VIDEO_IDS=<uuid,...> sau populează staging-ul.");
  return { ids };
}

function readOnly(videoId) {
  const like = get(`/api/videos/${videoId}/like`, "like_get", { auth: true });
  checkJson(like, "like_get", (b) => typeof b.liked === "boolean");
  const comments = get(`/api/videos/${videoId}/comments?limit=20`, "comments_list", { auth: true });
  checkJson(comments, "comments_list", (b) => Array.isArray(b.comments));
}

function likeCycle(videoId) {
  const on = send("PUT", `/api/videos/${videoId}/like`, null, "like_put", { auth: true });
  checkJson(on, "like_put", (b) => b.liked === true && typeof b.likeCount === "number");
  sleep(0.5);
  const off = send("DELETE", `/api/videos/${videoId}/like`, null, "like_delete", { auth: true });
  checkJson(off, "like_delete", (b) => b.liked === false);
}

function commentCycle(videoId) {
  const text = `k6 load test ${__VU}-${__ITER}`;
  const res = send("POST", `/api/videos/${videoId}/comments`, { text }, "comment_post", { auth: true });
  const ok = check(res, { "comment_post: 201 sau 429/422 tolerabil": (r) => [201, 422, 429].indexOf(r.status) !== -1 });
  const body = json(res);
  const commentId = ok && body && body.comment ? body.comment.id : null;
  if (!commentId) return;
  sleep(0.5);
  const del = send("DELETE", `/api/videos/${videoId}/comments?comment_id=${commentId}`, null, "comment_delete", { auth: true });
  checkJson(del, "comment_delete", (b) => b.success === true);
}

export default function iteration(data) {
  const videoId = pick(data.ids);
  readOnly(videoId);
  if (ALLOW_WRITES) {
    sleep(0.5);
    likeCycle(videoId);
    if (Math.random() < COMMENT_RATIO) {
      sleep(0.5);
      commentCycle(videoId);
    }
  }
  sleep(1 + Math.random() * 2);
}
