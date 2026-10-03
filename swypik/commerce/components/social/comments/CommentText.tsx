"use client";

import { Fragment } from "react";
import { Link } from "@/lib/i18n/navigation";
import { profilePath } from "@/lib/social/links";

/** Aceeași regulă ca MENTION_RE din lib/social/comments/mentions.ts (server). */
const MENTION_SPLIT = /(^|[^a-z0-9_.@])@([a-z0-9_]{3,30})/gi;

/** Textul comentariului cu @mențiunile transformate în linkuri spre profil. */
export function CommentText({ text }: { text: string }) {
  const parts: (string | { username: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_SPLIT)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ username: match[2] });
    last = start + match[2].length + 1;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-5 text-fg">
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <Link key={i} href={profilePath(part.username.toLowerCase())} className="font-semibold text-brand hover:underline">
            @{part.username}
          </Link>
        ),
      )}
    </p>
  );
}
