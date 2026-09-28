"use client";

import { useState, useTransition, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ui/ConfirmDialog";

type TextKey =
  | "product_description"
  | "customer_name"
  | "customer_email_address"
  | "customer_communication_text"
  | "shipping_address"
  | "shipping_carrier"
  | "shipping_tracking_number"
  | "shipping_date"
  | "service_date"
  | "refund_policy_disclosure"
  | "uncategorized_text";

type FileKey =
  | "receipt"
  | "shipping_documentation"
  | "service_documentation"
  | "customer_signature"
  | "customer_communication"
  | "refund_policy"
  | "uncategorized_file";

type EvidenceShape = Partial<Record<TextKey | FileKey, string>>;
type Translator = ReturnType<typeof useTranslations>;

function getFields(t: Translator): { key: TextKey; label: string; placeholder?: string; multiline?: boolean }[] {
  return [
    { key: "product_description", label: t("fieldProductDescription"), multiline: true, placeholder: t("fieldProductDescriptionPh") },
    { key: "customer_name", label: t("fieldCustomerName") },
    { key: "customer_email_address", label: t("fieldCustomerEmail") },
    { key: "customer_communication_text", label: t("fieldCustomerCommText"), multiline: true },
    { key: "shipping_address", label: t("fieldShippingAddress"), multiline: true },
    { key: "shipping_carrier", label: t("fieldShippingCarrier") },
    { key: "shipping_tracking_number", label: t("fieldTrackingNumber") },
    { key: "shipping_date", label: t("fieldShippingDate") },
    { key: "service_date", label: t("fieldServiceDate") },
    { key: "refund_policy_disclosure", label: t("fieldRefundPolicyText"), multiline: true },
    { key: "uncategorized_text", label: t("fieldOtherNotes"), multiline: true },
  ];
}

function getFileFields(t: Translator): { key: FileKey; label: string }[] {
  return [
    { key: "receipt", label: t("fileReceipt") },
    { key: "shipping_documentation", label: t("fileShippingDoc") },
    { key: "service_documentation", label: t("fileServiceDoc") },
    { key: "customer_signature", label: t("fileCustomerSignature") },
    { key: "customer_communication", label: t("fileCommScreenshot") },
    { key: "refund_policy", label: t("fileRefundPolicyPdf") },
    { key: "uncategorized_file", label: t("fileOther") },
  ];
}

type FileSlot = { fileId?: string; filename?: string; uploading: boolean; error?: string };

export default function DisputeEvidenceForm({
  disputeId,
  draft,
  suggestions,
}: {
  disputeId: string;
  draft: Record<string, unknown> | null;
  suggestions?: { key: string; potentialDelta: number; newScore: number }[];
}) {
  const t = useTranslations("adminDisputes");
  const FIELDS = getFields(t);
  const FILE_FIELDS = getFileFields(t);
  const suggMap = new Map<string, { potentialDelta: number; newScore: number }>();
  for (const s of suggestions || []) suggMap.set(s.key, s);
  const router = useRouter();
  const [evidence, setEvidence] = useState<EvidenceShape>(() => {
    const init: EvidenceShape = {};
    if (draft) {
      for (const f of [...FIELDS, ...FILE_FIELDS]) {
        const v = draft[f.key];
        if (typeof v === "string") init[f.key] = v;
      }
    }
    return init;
  });
  const [fileSlots, setFileSlots] = useState<Partial<Record<FileKey, FileSlot>>>(() => {
    const init: Partial<Record<FileKey, FileSlot>> = {};
    if (draft) {
      for (const f of FILE_FIELDS) {
        const v = draft[f.key];
        if (typeof v === "string") init[f.key] = { fileId: v, filename: v, uploading: false };
      }
    }
    return init;
  });
  const fileInputRefs = useRef<Partial<Record<FileKey, HTMLInputElement | null>>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [sending, setSending] = useState<"draft" | "submit" | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof EvidenceShape>(key: K, value: string) {
    setEvidence((prev) => ({ ...prev, [key]: value }));
  }

  function translateApiError(code: string | undefined, status: number): string {
    switch (code) {
      case "unauthorized":
        return t("errUnauthorized");
      case "invalid_json_body":
        return t("errInvalidJsonBody");
      case "invalid_dispute_id":
        return t("errInvalidDisputeId");
      case "dispute_not_found":
        return t("errDisputeNotFound");
      case "evidence_already_submitted":
        return t("errEvidenceAlreadySubmitted");
      case "stripe_error":
        return t("errStripe");
      default:
        return code || t("httpError", { status });
    }
  }

  async function applySuggestions() {
    setSuggesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/disputes/${disputeId}/suggest`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(translateApiError(data?.error, res.status));
        return;
      }
      const s = (data.suggestion || {}) as Partial<Record<TextKey, string>>;
      const empty = (k: TextKey) => !evidence[k] || !String(evidence[k]).trim();
      setEvidence((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(s)) {
          if (typeof v === "string" && empty(k as TextKey)) next[k as TextKey] = v;
        }
        return next;
      });
      setOkMsg(t("suggestionsApplied", { n: Object.keys(s).length }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("unknownError"));
    } finally {
      setSuggesting(false);
    }
  }

  async function uploadFile(key: FileKey, file: File) {
    setFileSlots((prev) => ({ ...prev, [key]: { uploading: true } }));
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`/api/admin/disputes/${disputeId}/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setFileSlots((prev) => ({ ...prev, [key]: { uploading: false, error: translateApiError(data?.error, res.status) } }));
        return;
      }
      setFileSlots((prev) => ({
        ...prev,
        [key]: { uploading: false, fileId: data.file_id, filename: data.filename },
      }));
      setEvidence((prev) => ({ ...prev, [key]: data.file_id }));
    } catch (e: unknown) {
      setFileSlots((prev) => ({ ...prev, [key]: { uploading: false, error: e instanceof Error ? e.message : t("unknownError") } }));
    }
  }

  function clearFile(key: FileKey) {
    setFileSlots((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setEvidence((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    const ref = fileInputRefs.current[key];
    if (ref) ref.value = "";
  }

  async function send(submit: boolean) {
    if (sending) return; // double-submit protection
    setError(null);
    setOkMsg(null);
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(evidence)) {
      if (typeof v === "string" && v.trim()) payload[k] = v.trim();
    }
    if (submit && Object.keys(payload).length === 0) {
      setError(t("submitNeedsField"));
      return;
    }
    setSending(submit ? "submit" : "draft");
    try {
      const res = await fetch("/api/admin/disputes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disputeId, evidence: payload, submit }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(translateApiError(data?.error, res.status));
        return;
      }
      setOkMsg(submit ? t("sentToStripe", { status: data.status }) : t("draftSaved"));
      if (submit) startTransition(() => router.refresh());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("unknownError"));
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="space-y-3 bg-white border border-[#E5E5E5] rounded p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm text-[#0D0D0D]">{t("respondTitle")}</div>
        <button
          type="button"
          onClick={applySuggestions}
          disabled={suggesting}
          className="px-2.5 py-1 rounded text-xs font-semibold bg-violet-100 text-violet-800 hover:bg-violet-200 disabled:opacity-60"
        >
          {suggesting ? t("autoFilling") : t("autoFillBtn")}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {FIELDS.map((f) => {
          const sugg = suggMap.get(f.key);
          const ringCls = sugg
            ? "border-violet-400 ring-1 ring-violet-200"
            : "border-[#E5E5E5]";
          return (
            <label key={f.key} className="text-xs flex flex-col gap-1">
              <span className="flex items-center justify-between gap-1">
                <span className="text-gray-600">{f.label}</span>
                {sugg && (
                  <span
                    className="text-[10px] font-bold bg-violet-100 text-violet-800 px-1.5 py-0.5 rounded"
                    title={t("scoreBoostTitle", { score: sugg.newScore })}
                  >
                    {t("scoreBoostPts", { delta: sugg.potentialDelta })}
                  </span>
                )}
              </span>
              {f.multiline ? (
                <textarea
                  rows={3}
                  placeholder={f.placeholder}
                  value={evidence[f.key] || ""}
                  onChange={(e) => update(f.key, e.target.value)}
                  className={`border rounded p-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 resize-y ${ringCls}`}
                />
              ) : (
                <input
                  type="text"
                  placeholder={f.placeholder}
                  value={evidence[f.key] || ""}
                  onChange={(e) => update(f.key, e.target.value)}
                  className={`border rounded p-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 ${ringCls}`}
                />
              )}
            </label>
          );
        })}
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-700 mb-1">{t("filesLabel")}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {FILE_FIELDS.map((f) => {
            const slot = fileSlots[f.key];
            const sugg = suggMap.get(f.key);
            const borderCls = sugg
              ? "border-violet-400 bg-violet-50/40 ring-1 ring-violet-200"
              : "border-[#E5E5E5] bg-gray-50/50";
            return (
              <div key={f.key} className={`border rounded p-2 ${borderCls}`}>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <div className="text-xs text-gray-600">{f.label}</div>
                  {sugg && (
                    <span
                      className="text-[10px] font-bold bg-violet-100 text-violet-800 px-1.5 py-0.5 rounded"
                      title={t("scoreBoostTitle", { score: sugg.newScore })}
                    >
                      {t("scoreBoostPts", { delta: sugg.potentialDelta })}
                    </span>
                  )}
                </div>
                {slot?.fileId ? (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono bg-green-100 text-green-800 px-1.5 py-0.5 rounded">
                      {slot.fileId.slice(0, 18)}…
                    </span>
                    <span className="text-gray-500 truncate" title={slot.filename}>{slot.filename}</span>
                    <button
                      type="button"
                      onClick={() => clearFile(f.key)}
                      className="ml-auto text-red-600 hover:underline"
                    >
                      {t("removeFile")}
                    </button>
                  </div>
                ) : slot?.uploading ? (
                  <div className="text-xs text-gray-500">{t("uploadingStripe")}</div>
                ) : (
                  <input
                    ref={(el) => {
                      fileInputRefs.current[f.key] = el;
                    }}
                    type="file"
                    aria-label={f.label}
                    accept="application/pdf,image/png,image/jpeg,image/gif"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadFile(f.key, file);
                    }}
                    className="text-xs w-full"
                  />
                )}
                {slot?.error && <div className="text-xs text-red-700 mt-1">{slot.error}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {okMsg && <p className="text-xs text-green-700">{okMsg}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => send(false)}
          disabled={pending || !!sending}
          className="px-3 py-1.5 min-h-[36px] rounded-lg text-xs font-semibold border border-[#E5E5E5] hover:bg-gray-50 disabled:opacity-60"
        >
          {sending === "draft" ? t("sending") : t("saveDraftBtn")}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await confirm({ title: t("submitConfirm"), confirmLabel: t("sendToStripeBtn") })) send(true);
          }}
          disabled={pending || !!sending}
          className="px-3 py-1.5 min-h-[36px] rounded-lg text-xs font-bold bg-[#0D0D0D] text-white hover:bg-black disabled:opacity-60"
        >
          {pending || sending === "submit" ? t("sending") : t("sendToStripeBtn")}
        </button>
      </div>
      {confirmDialog}
    </div>
  );
}
