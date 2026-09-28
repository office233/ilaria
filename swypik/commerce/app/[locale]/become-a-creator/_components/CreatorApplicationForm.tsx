"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { ApplicationState } from "@/lib/creator/application";

const HANDLE_RE = /^[a-z0-9_.]{3,32}$/i;
const MAX_LINKS = 5;
const MAX_MOTIVATION = 500;
const KNOWN_ERRORS = ["handle_taken", "seller_cannot_apply", "already_creator", "rate_limited", "unauthorized"];

type FieldName = "handle" | "category" | "links" | "motivation";
type Errors = Partial<Record<FieldName | "form", string>>;

type Props = {
  categories: readonly string[];
  defaultHandle: string;
  onSubmitted: (state: ApplicationState) => void;
};

export function CreatorApplicationForm({ categories, defaultHandle, onSubmitted }: Props) {
  const t = useTranslations("becomeCreatorForm");
  const [handle, setHandle] = useState(defaultHandle);
  const [category, setCategory] = useState("");
  const [links, setLinks] = useState<string[]>([""]);
  const [motivation, setMotivation] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const fieldError = (field: string): Errors => {
    if (field === "handle") return { handle: t("errors.handleInvalid") };
    if (field === "category") return { category: t("errors.categoryRequired") };
    if (field === "links") return { links: t("errors.linksInvalid") };
    if (field === "motivation") return { motivation: t("errors.motivationTooLong", { max: MAX_MOTIVATION }) };
    return { form: t("errors.generic") };
  };

  function validate(cleanLinks: string[]): Errors {
    const next: Errors = {};
    if (!HANDLE_RE.test(handle.trim())) Object.assign(next, fieldError("handle"));
    if (!category) Object.assign(next, fieldError("category"));
    if (cleanLinks.some((l) => !/^https:\/\/[^\s]+\.[^\s]+$/i.test(l))) Object.assign(next, fieldError("links"));
    if (motivation.length > MAX_MOTIVATION) Object.assign(next, fieldError("motivation"));
    return next;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cleanLinks = links.map((l) => l.trim()).filter(Boolean);
    const found = validate(cleanLinks);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch("/api/creator/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle.trim(),
          category,
          links: cleanLinks,
          motivation: motivation.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string } & Partial<ApplicationState>;
      if (res.ok && body.state) {
        onSubmitted(body as ApplicationState);
        return;
      }
      const code = body.error ?? "generic";
      if (code === "invalid_body") setErrors(fieldError(body.field ?? ""));
      else if (code === "handle_taken") setErrors({ handle: t("errors.handle_taken") });
      else setErrors({ form: KNOWN_ERRORS.includes(code) ? t(`errors.${code}`) : t("errors.generic") });
    } catch {
      setErrors({ form: t("errors.network") });
    } finally {
      setBusy(false);
    }
  }

  const setLink = (i: number, value: string) => setLinks((prev) => prev.map((l, j) => (j === i ? value : l)));

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label={t("handleLabel")} hint={t("handleHint")} error={errors.handle} required>
        {(f) => (
          <Input
            {...f}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            leadingIcon={<span className="text-sm font-semibold">@</span>}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
          />
        )}
      </Field>

      <Field label={t("categoryLabel")} error={errors.category} required>
        {(f) => (
          <Select
            {...f}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={t("categoryPlaceholder")}
            options={categories.map((c) => ({ value: c, label: t(`categories.${c}`) }))}
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">{t("linksLabel")}</legend>
        <p className="text-xs text-muted">{t("linksHint", { max: MAX_LINKS })}</p>
        {links.map((link, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              type="url"
              inputMode="url"
              value={link}
              onChange={(e) => setLink(i, e.target.value)}
              placeholder={t("linkPlaceholder")}
              aria-label={t("linkAria", { n: i + 1 })}
              aria-invalid={errors.links ? true : undefined}
              autoCapitalize="none"
              spellCheck={false}
              className="flex-1"
            />
            {links.length > 1 ? (
              <IconButton label={t("removeLink")} onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden />
              </IconButton>
            ) : null}
          </div>
        ))}
        {errors.links ? <p className="text-xs font-medium text-danger">{errors.links}</p> : null}
        {links.length < MAX_LINKS ? (
          <Button variant="ghost" size="sm" onClick={() => setLinks((prev) => [...prev, ""])}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("addLink")}
          </Button>
        ) : null}
      </fieldset>

      <Field
        label={t("motivationLabel")}
        hint={t("motivationHint", { count: motivation.length, max: MAX_MOTIVATION })}
        error={errors.motivation}
      >
        {(f) => (
          <Textarea
            {...f}
            value={motivation}
            onChange={(e) => setMotivation(e.target.value)}
            maxLength={MAX_MOTIVATION}
            rows={4}
          />
        )}
      </Field>

      {errors.form ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {errors.form}
        </p>
      ) : null}

      <Button type="submit" block size="lg" loading={busy}>
        {t("submit")}
      </Button>
    </form>
  );
}
