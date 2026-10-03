"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field, Textarea, TextField } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/lib/i18n/navigation";
import { profilePath } from "@/lib/social/links";
import { AvatarPicker } from "./AvatarPicker";
import { LinksEditor, MAX_LINKS, type EditableLink } from "./LinksEditor";
import { UsernameField, type UsernameStatus } from "./UsernameField";

type Me = { username: string; display_name: string | null; bio: string | null; avatar_url: string | null };

const BIO_MAX = 300;
const NAME_MAX = 50;
const KNOWN_ERRORS = new Set([
  "rate_limited", "display_name_rejected", "bio_rejected", "username_invalid", "username_reserved",
  "username_taken", "links_save_failed", "categories_save_failed", "profile_update_failed", "validation_error",
]);

/** „Editează profilul": avatar, nume, username (cu alias pentru linkurile vechi), bio, linkuri, categorii. */
export function EditProfileForm() {
  const t = useTranslations("social.edit");
  const router = useRouter();
  const { toast } = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("idle");
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState<EditableLink[]>([]);
  const [categories, setCategories] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/auth", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/users/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([auth, social]) => {
        if (cancelled) return;
        if (!auth?.authenticated || !auth.customer) {
          router.replace(`/auth?next=${encodeURIComponent("/account/edit")}`);
          return;
        }
        const c = auth.customer as Me;
        setMe(c);
        setName(c.display_name ?? "");
        setUsername(c.username ?? "");
        setBio(c.bio ?? "");
        setLinks(Array.isArray(social?.links) ? social.links.slice(0, MAX_LINKS) : []);
        setCategories(Array.isArray(social?.categories) ? social.categories.join(", ") : "");
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!me || saving) return;
    const body: Record<string, unknown> = {
      links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label && l.url),
      categories: categories.split(",").map((c) => c.trim().toLowerCase()).filter((c) => c.length >= 2).slice(0, 8),
    };
    if (name.trim() !== (me.display_name ?? "")) body.display_name = name.trim();
    if (username !== me.username) body.username = username;
    if (bio.trim() !== (me.bio ?? "")) body.bio = bio.trim();

    setSaving(true);
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = KNOWN_ERRORS.has(data?.code) ? data.code : KNOWN_ERRORS.has(data?.error) ? data.error : "profile_update_failed";
        toast({ title: t(`errors.${code}`), tone: "danger" });
        return;
      }
      toast({ title: t("saved"), tone: "success" });
      router.push(profilePath(data?.user?.username ?? username));
      router.refresh();
    } catch {
      toast({ title: t("errors.profile_update_failed"), tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="flex flex-col items-center gap-4 px-gutter py-6" aria-busy="true">
        <Skeleton className="h-24 w-24 rounded-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (status === "error" || !me) return <ErrorState className="py-16" onRetry={() => window.location.reload()} />;

  const usernameBlocked = usernameStatus === "checking" || usernameStatus.startsWith("username_");

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-md flex-col gap-5 px-gutter py-6">
      <AvatarPicker name={name || username} initialUrl={me.avatar_url} />
      <TextField
        label={t("displayName")}
        hint={`${name.length}/${NAME_MAX}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={NAME_MAX}
        required
      />
      <UsernameField value={username} original={me.username} onChange={setUsername} onStatus={setUsernameStatus} />
      <Field label={t("bio")} hint={`${bio.length}/${BIO_MAX}`}>
        {(field) => (
          <Textarea
            {...field}
            rows={4}
            value={bio}
            maxLength={BIO_MAX}
            onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
            placeholder={t("bioPlaceholder")}
          />
        )}
      </Field>
      <LinksEditor links={links} onChange={setLinks} />
      <TextField
        label={t("categories")}
        hint={t("categoriesHint")}
        value={categories}
        onChange={(e) => setCategories(e.target.value)}
      />
      <div className="sticky flex gap-3 border-t border-subtle bg-canvas py-3" style={{ bottom: "var(--bottom-inset)" }}>
        <Button type="button" variant="secondary" className="flex-1" onClick={() => router.back()} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button type="submit" className="flex-[2]" loading={saving} disabled={usernameBlocked}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
