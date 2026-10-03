/**
 * Email transport — abstractizare peste Resend și SMTP.
 *
 * Ordinea de alegere:
 *   1. RESEND_API_KEY  → Resend (API HTTP, cel mai simplu)
 *   2. SMTP_HOST       → SMTP clasic (IONOS, Amazon SES, Gmail, orice)
 *   3. niciunul        → no-op, doar log (dev)
 *
 * Toate rutele existente cheamă `sendMail()`; nu trebuie să știe ce provider e.
 *
 * Variabile SMTP:
 *   SMTP_HOST, SMTP_PORT (465 = TLS implicit, 587 = STARTTLS),
 *   SMTP_USER, SMTP_PASS, SMTP_SECURE ("1" pentru 465)
 */
import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "@/lib/logger";
import { emailFrom, emailReplyTo, isPlaceholderSecret } from "./config";

const log = logger.child({ service: "email-transport" });

export type MailProvider = "resend" | "smtp" | "none";

export interface MailInput {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
}

let _resend: Resend | null = null;
let _smtp: Transporter | null = null;

export function activeProvider(): MailProvider {
    if (!isPlaceholderSecret(process.env.RESEND_API_KEY)) return "resend";
    if (!isPlaceholderSecret(process.env.SMTP_HOST)) return "smtp";
    return "none";
}

/** Emailul poate pleca efectiv (provider real, nu placeholder). */
export function emailConfigured(): boolean {
    return activeProvider() !== "none";
}

function getResend(): Resend | null {
    const key = process.env.RESEND_API_KEY;
    if (!key || isPlaceholderSecret(key)) return null;
    if (!_resend) _resend = new Resend(key);
    return _resend;
}

function getSmtp(): Transporter | null {
    const host = process.env.SMTP_HOST;
    if (!host || isPlaceholderSecret(host)) return null;
    if (_smtp) return _smtp;

    const port = Number(process.env.SMTP_PORT) || 587;
    _smtp = nodemailer.createTransport({
        host,
        port,
        secure: process.env.SMTP_SECURE === "1" || port === 465,
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
            : undefined,
        // rate-limit prietenos cu providerii care limitează conexiunile
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
    });
    return _smtp;
}

/**
 * Trimite un email prin providerul configurat.
 * Returnează `true` numai dacă providerul a acceptat mesajul.
 */
export async function sendMail(input: MailInput): Promise<boolean> {
    const provider = activeProvider();

    if (provider === "none") {
        log.warn({ to: maskEmail(input.to) }, "email not configured — mesaj netrimis (RESEND_API_KEY/SMTP_HOST lipsă sau placeholder)");
        return false;
    }

    const from = emailFrom();
    const replyTo = input.replyTo ?? emailReplyTo();
    try {
        if (provider === "resend") {
            const r = getResend();
            if (!r) return false;
            const { error } = await r.emails.send({
                from,
                to: input.to,
                subject: input.subject,
                html: input.html,
                text: input.text,
                replyTo,
                headers: input.headers,
            });
            if (error) {
                log.error({ err: error, to: maskEmail(input.to) }, "resend send failed");
                return false;
            }
            return true;
        }

        const t = getSmtp();
        if (!t) return false;
        await t.sendMail({
            from,
            to: input.to,
            subject: input.subject,
            html: input.html,
            text: input.text,
            replyTo,
            headers: input.headers,
        });
        return true;
    } catch (err) {
        log.error({ err, provider, to: maskEmail(input.to) }, "email send failed");
        return false;
    }
}

/** Verifică dacă providerul chiar funcționează (pentru /api/health). */
export async function verifyTransport(): Promise<{ ok: boolean; provider: MailProvider; error?: string }> {
    const provider = activeProvider();
    if (provider === "none") return { ok: false, provider };
    if (provider === "resend") return { ok: true, provider };
    try {
        const t = getSmtp();
        if (!t) return { ok: false, provider, error: "smtp not initialised" };
        await t.verify();
        return { ok: true, provider };
    } catch (err) {
        return { ok: false, provider, error: (err as Error).message };
    }
}

function maskEmail(e: string | null | undefined): string {
    if (!e || !e.includes("@")) return "<none>";
    const [u, d] = e.split("@");
    return `${u.slice(0, 2)}***@${d}`;
}
