"use client";

/**
 * Formularul unei listări (creare / editare) într-un sheet de jos. Prețul se
 * introduce în unități întregi de monedă și se trimite în bani.
 */
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Field, TextField, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Sheet } from "@/components/ui/Sheet";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { errorKey } from "@/components/stays/format";
import { PhotoUploader } from "@/components/stays/PhotoUploader";
import { STAY_AMENITIES, STAY_PROPERTY_TYPES, type StayAmenity } from "@/lib/stays/config";
import type { HostListing } from "@/lib/stays/listings";
import type { HostLimits } from "./HostPanelClient";

type Props = { open: boolean; onOpenChange: (o: boolean) => void; listing: HostListing | null; limits: HostLimits; defaultCity: string | null; onSaved: () => void };

function initial(l: HostListing | null, city: string | null) {
    const m = (l?.metadata ?? {}) as Record<string, unknown>;
    const a = (l?.vertical_attributes ?? {}) as Record<string, unknown>;
    return {
        title: l?.title ?? "",
        description: l?.description ?? "",
        price: l?.price_cents ? String(l.price_cents / 100) : "",
        maxGuests: String(m.max_guests ?? 2),
        city: l?.location_city ?? city ?? "",
        address: typeof m.address === "string" ? m.address : "",
        propertyType: typeof m.property_type === "string" ? m.property_type : "",
        houseRules: typeof m.house_rules === "string" ? m.house_rules : "",
        amenities: STAY_AMENITIES.filter((k) => a[k] === true) as StayAmenity[],
        imageUrls: Array.isArray(m.image_urls) ? (m.image_urls as string[]) : l?.image_url ? [l.image_url] : [],
    };
}

export default function ListingFormSheet({ open, onOpenChange, listing, limits, defaultCity, onSaved }: Props) {
    const t = useTranslations("staysHost");
    const tu = useTranslations("staysUi");
    const { toast } = useToast();
    const [form, setForm] = useState(() => initial(listing, defaultCity));
    const [busy, setBusy] = useState(false);
    const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const body = {
            title: form.title,
            description: form.description || undefined,
            pricePerNightCents: Math.round(Number(form.price.replace(",", ".")) * 100),
            maxGuests: Number(form.maxGuests),
            city: form.city,
            address: form.address || undefined,
            propertyType: form.propertyType || undefined,
            houseRules: form.houseRules || undefined,
            amenities: form.amenities,
            imageUrls: form.imageUrls,
        };
        const res = await fetch(listing ? `/api/host/listings/${listing.id}` : "/api/host/listings", {
            method: listing ? "PATCH" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }).catch(() => null);
        setBusy(false);
        if (!res?.ok) {
            const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
            toast({ title: tu(errorKey(j.error)), tone: "danger" });
            return;
        }
        toast({ title: t("savedToast"), tone: "success" });
        onSaved();
        onOpenChange(false);
    };

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={listing ? t("editListing") : t("newListing")}
            footer={<Button type="submit" form="listing-form" block size="lg" loading={busy}>{t("save")}</Button>}
        >
            <form id="listing-form" onSubmit={submit} className="space-y-4">
                <PhotoUploader value={form.imageUrls} onChange={(v) => set("imageUrls", v)} max={limits.maxPhotos} />
                <TextField label={t("fieldTitle")} required minLength={5} maxLength={140} value={form.title} onChange={(e) => set("title", e.target.value)} />
                <Field label={t("fieldDescription")}>{(f) => <Textarea {...f} maxLength={4000} value={form.description} onChange={(e) => set("description", e.target.value)} />}</Field>
                <div className="grid grid-cols-2 gap-3">
                    <TextField
                        label={t("fieldPrice")}
                        required
                        inputMode="decimal"
                        value={form.price}
                        onChange={(e) => set("price", e.target.value)}
                        hint={t("priceHint", { min: limits.minPriceCents / 100 })}
                    />
                    <TextField label={t("fieldMaxGuests")} required type="number" inputMode="numeric" min={1} max={limits.maxGuests} value={form.maxGuests} onChange={(e) => set("maxGuests", e.target.value)} />
                </div>
                <TextField label={t("fieldCity")} required maxLength={80} value={form.city} onChange={(e) => set("city", e.target.value)} />
                <TextField label={t("fieldAddress")} hint={t("addressHint")} maxLength={200} value={form.address} onChange={(e) => set("address", e.target.value)} />
                <Field label={t("fieldPropertyType")}>
                    {(f) => (
                        <Select
                            {...f}
                            value={form.propertyType}
                            onChange={(e) => set("propertyType", e.target.value)}
                            placeholder={t("choose")}
                            options={STAY_PROPERTY_TYPES.map((p) => ({ value: p, label: t(`propertyType.${p}`) }))}
                        />
                    )}
                </Field>
                <fieldset className="space-y-2">
                    <legend className="mb-1 text-sm font-medium text-fg">{t("fieldAmenities")}</legend>
                    {STAY_AMENITIES.map((a) => (
                        <label key={a} className="flex min-h-11 items-center justify-between gap-3 text-sm text-fg">
                            {tu(`amenity.${a}`)}
                            <Switch
                                aria-label={tu(`amenity.${a}`)}
                                checked={form.amenities.includes(a)}
                                onCheckedChange={(on) => set("amenities", on ? [...form.amenities, a] : form.amenities.filter((x) => x !== a))}
                            />
                        </label>
                    ))}
                </fieldset>
                <Field label={t("fieldHouseRules")}>{(f) => <Textarea {...f} maxLength={2000} value={form.houseRules} onChange={(e) => set("houseRules", e.target.value)} />}</Field>
            </form>
        </Sheet>
    );
}
