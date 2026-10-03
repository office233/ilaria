/**
 * Safe, tiny markdown renderer for AI summaries: ## headings, > quotes,
 * - lists, **bold**, paragraphs. Produces plain React nodes — never
 * dangerouslySetInnerHTML — so the (untrusted) model output can't inject HTML.
 */
import { Fragment, type ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`} className="font-semibold text-fg">{part.slice(2, -2)}</strong>
      : <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>,
  );
}

export function renderNewsMarkdown(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = (key: string) => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(<p key={key}>{renderInline(text, key)}</p>);
    paragraph = [];
  };
  const flushList = (key: string) => {
    if (list.length) {
      blocks.push(
        <ul key={key} className="list-disc space-y-1 pl-5">
          {list.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}
        </ul>,
      );
    }
    list = [];
  };

  (markdown || "").split(/\r?\n/).forEach((rawLine, idx) => {
    const line = rawLine.trim();
    const key = `b-${idx}`;
    if (!line || line.startsWith("## ") || line.startsWith("> ")) {
      flushParagraph(`p-${idx}`);
      flushList(`l-${idx}`);
    }
    if (!line) return;
    if (line.startsWith("## ")) {
      blocks.push(<h2 key={key} className="pt-4 text-lg font-semibold text-fg">{renderInline(line.slice(3), key)}</h2>);
      return;
    }
    if (line.startsWith("> ")) {
      blocks.push(
        <blockquote key={key} className="rounded-r-control border-l-4 border-brand bg-surface-2 px-4 py-2 italic">
          {renderInline(line.slice(2), key)}
        </blockquote>,
      );
      return;
    }
    if (line.startsWith("- ")) {
      flushParagraph(`p-${idx}`);
      list.push(line.slice(2));
      return;
    }
    flushList(`l-${idx}`);
    paragraph.push(line);
  });
  flushParagraph("p-end");
  flushList("l-end");
  return blocks;
}
