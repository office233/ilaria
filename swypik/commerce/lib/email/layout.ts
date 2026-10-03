/**
 * Layout-ul unic al emailurilor Swypik: header de brand, conținut din blocuri,
 * footer cu ajutor + motivul primirii și — DOAR pentru marketing — linkul de
 * dezabonare. Fiecare șablon produce și varianta text/plain din aceleași
 * blocuri (antispam + clienți fără HTML).
 */
import { SUPPORT_EMAIL } from "@/lib/contact";
import type { Locale } from "@/lib/i18n/config";
import { escapeHtml } from "./escape";
import type { Translate } from "./i18n";
import { emailLink } from "./links";
import { EMAIL_THEME as C } from "./theme";

export type EmailCard = { title: string; href: string; image?: string | null; meta?: string | null };
export type EmailListItem = { label: string; href?: string; meta?: string | null };

export type EmailBlock =
  | { type: "p"; text: string }
  | { type: "small"; text: string }
  | { type: "code"; text: string }
  | { type: "button"; label: string; href: string }
  | { type: "buttons"; items: { label: string; href: string }[] }
  | { type: "link"; href: string }
  | { type: "box"; label: string; text: string; tone?: "brand" | "danger" | "success" }
  | { type: "heading"; text: string }
  | { type: "table"; head: string[]; rows: string[][]; foot?: [string, string] }
  | { type: "cards"; items: EmailCard[] }
  | { type: "list"; items: EmailListItem[] }
  | { type: "rows"; items: [string, string][] }
  /** HTML deja sigur (doar pentru fragmentele moștenite de la apelanți vechi). */
  | { type: "raw"; html: string; text: string };

export type EmailContent = {
  locale: Locale;
  title: string;
  preheader?: string;
  blocks: EmailBlock[];
  /** Setat DOAR pentru emailurile de marketing — adaugă footer-ul de dezabonare. */
  unsubscribeUrl?: string;
};

export type RenderedEmail = { html: string; text: string };

const P = `margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.fg}`;

function button(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${C.brand};color:${C.brandFg};padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;text-decoration:none;margin:4px">${escapeHtml(label)}</a>`;
}

function toneColors(tone: "brand" | "danger" | "success" = "brand"): [string, string] {
  if (tone === "danger") return [C.dangerSoft, C.danger];
  if (tone === "success") return [C.successSoft, C.success];
  return [C.brandSoft, C.brandSoftFg];
}

function blockHtml(b: EmailBlock): string {
  switch (b.type) {
    case "p":
      return `<p style="${P}">${escapeHtml(b.text)}</p>`;
    case "small":
      return `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${C.fgSubtle}">${escapeHtml(b.text)}</p>`;
    case "heading":
      return `<h2 style="margin:24px 0 12px;font-size:17px;font-weight:800;color:${C.fg}">${escapeHtml(b.text)}</h2>`;
    case "code":
      return `<div style="margin:8px 0 20px;padding:16px;background:${C.surface2};border-radius:12px;text-align:center;font-family:${C.mono};font-size:32px;font-weight:800;letter-spacing:6px;color:${C.fg}">${escapeHtml(b.text)}</div>`;
    case "button":
      return `<div style="text-align:center;margin:24px 0">${button(b.label, b.href)}</div>`;
    case "buttons":
      return `<div style="text-align:center;margin:24px 0">${b.items.map((i) => button(i.label, i.href)).join("")}</div>`;
    case "link":
      return `<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:${C.fgSubtle};word-break:break-all"><a href="${escapeHtml(b.href)}" style="color:${C.brand}">${escapeHtml(b.href)}</a></p>`;
    case "box": {
      const [bg, fg] = toneColors(b.tone);
      return `<div style="margin:16px 0 20px;padding:16px 20px;background:${bg};border-radius:12px"><p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${fg}">${escapeHtml(b.label)}</p><p style="margin:0;font-size:16px;font-weight:700;color:${C.fg};word-break:break-word">${escapeHtml(b.text)}</p></div>`;
    }
    case "table": {
      const th = (t: string, i: number) =>
        `<th style="padding:8px;text-align:${i === 0 ? "left" : "right"};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.fgSubtle}">${escapeHtml(t)}</th>`;
      const td = (t: string, i: number) =>
        `<td style="padding:12px 8px;border-bottom:1px solid ${C.border};font-size:14px;text-align:${i === 0 ? "left" : "right"};color:${C.fg}">${escapeHtml(t)}</td>`;
      const foot = b.foot
        ? `<tfoot><tr><td colspan="${Math.max(1, b.head.length - 1)}" style="padding:14px 8px 0;font-size:16px;font-weight:800;color:${C.fg}">${escapeHtml(b.foot[0])}</td><td style="padding:14px 8px 0;text-align:right;font-size:16px;font-weight:800;color:${C.fg}">${escapeHtml(b.foot[1])}</td></tr></tfoot>`
        : "";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 20px"><thead><tr style="border-bottom:2px solid ${C.fg}">${b.head.map(th).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map(td).join("")}</tr>`).join("")}</tbody>${foot}</table>`;
    }
    case "cards": {
      const cell = (c: EmailCard) =>
        `<td style="padding:6px;vertical-align:top;width:33%"><a href="${escapeHtml(c.href)}" style="text-decoration:none;color:${C.fg}">${
          c.image ? `<img src="${escapeHtml(c.image)}" alt="" width="160" style="width:100%;max-width:160px;height:auto;border-radius:8px;display:block"/>` : ""
        }<div style="font-size:13px;font-weight:600;margin-top:6px">${escapeHtml(c.title)}</div>${
          c.meta ? `<div style="font-size:12px;color:${C.brand};margin-top:2px">${escapeHtml(c.meta)}</div>` : ""
        }</a></td>`;
      const rows: string[] = [];
      for (let i = 0; i < b.items.length; i += 3) rows.push(`<tr>${b.items.slice(i, i + 3).map(cell).join("")}</tr>`);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows.join("")}</table>`;
    }
    case "list":
      return `<ul style="margin:0 0 16px;padding-left:18px">${b.items
        .map((i) => {
          const label = i.href
            ? `<a href="${escapeHtml(i.href)}" style="color:${C.fg};font-weight:700;text-decoration:none">${escapeHtml(i.label)}</a>`
            : `<b>${escapeHtml(i.label)}</b>`;
          return `<li style="margin:6px 0;font-size:14px;color:${C.fg}">${label}${i.meta ? `<span style="color:${C.fgMuted}"> · ${escapeHtml(i.meta)}</span>` : ""}</li>`;
        })
        .join("")}</ul>`;
    case "rows":
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${b.items
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-size:14px;font-weight:700;color:${C.fgMuted};vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:14px;color:${C.fg}">${escapeHtml(v)}</td></tr>`)
        .join("")}</table>`;
    case "raw":
      return b.html;
  }
}

function blockText(b: EmailBlock): string {
  switch (b.type) {
    case "p":
    case "small":
      return b.text;
    case "heading":
      return `\n${b.text.toUpperCase()}`;
    case "code":
      return `    ${b.text}`;
    case "button":
      return `${b.label}: ${b.href}`;
    case "buttons":
      return b.items.map((i) => `${i.label}: ${i.href}`).join("\n");
    case "link":
      return b.href;
    case "box":
      return `${b.label}: ${b.text}`;
    case "table":
      return [...b.rows.map((r) => `- ${r.join(" | ")}`), ...(b.foot ? [`${b.foot[0]}: ${b.foot[1]}`] : [])].join("\n");
    case "cards":
      return b.items.map((c) => `- ${c.title}${c.meta ? ` (${c.meta})` : ""}: ${c.href}`).join("\n");
    case "list":
      return b.items.map((i) => `- ${i.label}${i.meta ? ` · ${i.meta}` : ""}${i.href ? `: ${i.href}` : ""}`).join("\n");
    case "rows":
      return b.items.map(([k, v]) => `${k}: ${v}`).join("\n");
    case "raw":
      return b.text;
  }
}

/** Randează conținutul în layout-ul de brand; `tc` = traducătorul `email.common`. */
export function renderEmail(content: EmailContent, tc: Translate): RenderedEmail {
  const { locale, title, blocks, unsubscribeUrl, preheader } = content;
  const help = tc("help", { email: SUPPORT_EMAIL });
  const why = unsubscribeUrl ? tc("whyMarketing") : tc("whyTransactional");
  const settingsUrl = emailLink(locale, "/account/notifications");
  const unsub = unsubscribeUrl
    ? `<p style="margin:8px 0 0;font-size:12px;color:${C.fgSubtle}"><a href="${escapeHtml(unsubscribeUrl)}" style="color:${C.fgSubtle};text-decoration:underline">${escapeHtml(tc("unsubscribe"))}</a> · <a href="${escapeHtml(settingsUrl)}" style="color:${C.fgSubtle};text-decoration:underline">${escapeHtml(tc("manageNotifications"))}</a></p>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:${C.font}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>` : ""}
<div style="max-width:560px;margin:32px auto;background:${C.surface};border-radius:16px;overflow:hidden;border:1px solid ${C.border}">
<div style="background:${C.brand};padding:24px 32px;text-align:center"><span style="color:${C.brandFg};font-size:24px;font-weight:900;letter-spacing:-0.5px">Swypik</span></div>
<div style="padding:32px">
<h1 style="margin:0 0 20px;font-size:22px;font-weight:900;line-height:1.3;color:${C.fg}">${escapeHtml(title)}</h1>
${blocks.map(blockHtml).join("\n")}
</div>
<div style="padding:20px 32px;background:${C.surface2};text-align:center;border-top:1px solid ${C.border}">
<p style="margin:0 0 6px;font-size:12px;color:${C.fgMuted}">${escapeHtml(tc("tagline"))}</p>
<p style="margin:0 0 6px;font-size:12px;color:${C.fgMuted}">${escapeHtml(help)}</p>
<p style="margin:0;font-size:11px;color:${C.fgSubtle}">${escapeHtml(why)}</p>
${unsub}
</div>
</div>
</body></html>`;

  const text = [
    "Swypik",
    "",
    title,
    "",
    ...blocks.map(blockText).filter(Boolean).flatMap((t) => [t, ""]),
    "--",
    tc("tagline"),
    help,
    why,
    ...(unsubscribeUrl ? [`${tc("unsubscribe")}: ${unsubscribeUrl}`] : []),
  ].join("\n");

  return { html, text };
}

/** Text simplu dintr-un fragment HTML (pentru apelanții care trimit doar HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, "")} (${href})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Titlul unui fragment moștenit: primul <h1>/<h2>, altfel subiectul. */
export function fragmentTitle(html: string, fallback: string): { title: string; body: string } {
  const m = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (!m) return { title: fallback, body: html };
  return { title: htmlToText(m[1]), body: html.replace(m[0], "") };
}
