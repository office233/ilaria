# Notifications — wiring guide

`notifyUser(recipientUserId, { type, actorUserId?, targetType?, targetId?, payload? })`
inserts a row into `notifications` and fires a Web Push (best-effort, async).
Self-notifications (actor === recipient) are skipped automatically.

Import:

```ts
import { notifyUser } from "@/lib/notifications/dispatch";
```

## 1) Comment POST  (e.g. `app/api/videos/[id]/comments/route.ts`)

After you have inserted the comment and have `video.user_id` (the creator) and
the commenting `userId`:

```ts
await notifyUser(video.user_id, {
  type: "comment",
  actorUserId: userId,
  targetType: "video",
  targetId: video.id,
  payload: {
    title: "Comentariu nou la videoclipul tau",
    body: comment.body.slice(0, 140),
    url: `/explore?v=${video.id}#comment-${comment.id}`,
    commentId: comment.id,
  },
});
```

## 2) Video like POST  (e.g. `app/api/videos/[id]/like/route.ts`)

After the like row is inserted (skip on un-like):

```ts
await notifyUser(video.user_id, {
  type: "like",
  actorUserId: userId,
  targetType: "video",
  targetId: video.id,
  payload: {
    title: "Cineva ti-a apreciat videoclipul",
    body: actorDisplayName ? `${actorDisplayName} a dat like` : "Ai un like nou",
    url: `/explore?v=${video.id}`,
  },
});
```

## 3) Follow POST  (e.g. `app/api/users/[id]/follow/route.ts`)

After inserting into `follows`:

```ts
await notifyUser(followedUserId, {
  type: "follow",
  actorUserId: userId,
  targetType: "user",
  targetId: userId,
  payload: {
    title: "Ai un nou follower",
    body: actorDisplayName ? `${actorDisplayName} te urmareste` : "Cineva te urmareste",
    url: `/profile/${actorUsername || userId}`,
  },
});
```

## Notes

- `notifyUser` is safe to `await` (DB insert is awaited; push is fire-and-forget).
  Failures inside push delivery never throw to the caller.
- For high-fan-out events (e.g. `creator_post` to many followers) iterate the
  follower list and call `notifyUser` per recipient; consider moving to a queue
  if follower count is large.
- `type` must match the CHECK constraint:
  `comment | like | follow | mention | creator_post | sale | price_drop`.
