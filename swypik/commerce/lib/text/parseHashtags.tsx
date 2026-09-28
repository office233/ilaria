import { Fragment, type ReactNode } from "react";
import Link from "next/link";

const TOKEN_RE = /(#[\p{L}\p{N}_]+|@[a-zA-Z0-9_.]+)/gu;

export function parseHashtags(text: string | null | undefined): ReactNode {
  if (!text) return null;
  const parts = text.split(TOKEN_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("#") && part.length > 1) {
      const tag = part.slice(1).toLowerCase();
      return (
        <Link
          key={i}
          href={`/hashtag/${tag}`}
          className="text-[#7C3AED] font-bold hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </Link>
      );
    }
    if (part.startsWith("@") && part.length > 1) {
      const username = part.slice(1);
      return (
        <Link
          key={i}
          href={`/u/${username}`}
          className="text-[#7C3AED] font-bold hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </Link>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function HashtagText({ text }: { text: string | null | undefined }) {
  return <>{parseHashtags(text)}</>;
}
