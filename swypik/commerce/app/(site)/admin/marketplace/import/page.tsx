"use client";

import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PreviewRow {
  [key: string]: string;
}

interface ImportError {
  row: number;
  reason: string;
  params?: Record<string, string>;
  data?: Record<string, string>;
}

interface ImportResult {
  success: boolean;
  imported: number;
  total: number;
  errors: ImportError[];
}

type Phase = "idle" | "preview" | "importing" | "done";

/* ------------------------------------------------------------------ */
/*  CSV parsing (client-side for preview)                              */
/* ------------------------------------------------------------------ */

function parseCsvPreview(raw: string): { headers: string[]; rows: PreviewRow[] } {
  const lines: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        current.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && raw[i + 1] === "\n")) {
        current.push(field);
        field = "";
        if (current.some((c) => c.trim() !== "")) lines.push(current);
        current = [];
        if (ch === "\r") i++;
      } else {
        field += ch;
      }
    }
  }
  current.push(field);
  if (current.some((c) => c.trim() !== "")) lines.push(current);

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: PreviewRow[] = [];
  for (let r = 1; r < lines.length; r++) {
    const obj: PreviewRow = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (lines[r][c] ?? "").trim();
    }
    rows.push(obj);
  }

  return { headers, rows };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const EXPECTED_COLUMNS = ["title", "price", "description", "image_url", "category", "stock"];

export default function BulkImportPage() {
    const t = useTranslations("adminImport");
  const [phase, setPhase] = useState<Phase>("idle");
  const [csvRaw, setCsvRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  /* ---- File handling ---- */

  const processFile = useCallback((file: File) => {
    if (!file.name.endsWith(".csv")) {
      alert(t("invalidCsvFile"));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setCsvRaw(text);
      setFileName(file.name);

      const { headers: h, rows } = parseCsvPreview(text);
      setHeaders(h);
      setPreviewRows(rows.slice(0, 5));
      setTotalRows(rows.length);
      setPhase("preview");
      setResult(null);
    };
    reader.readAsText(file, "utf-8");
  }, [t]);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  /* ---- Import ---- */

  const handleImport = useCallback(async () => {
    if (!csvRaw) return;
    setPhase("importing");
    setProgress(10);

    const progressInterval = setInterval(() => {
      setProgress((prev) => Math.min(prev + Math.random() * 12, 90));
    }, 400);

    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvRaw }),
      });

      clearInterval(progressInterval);
      setProgress(100);

      const data: ImportResult = await res.json();
      setResult(data);
      setPhase("done");
    } catch (err) {
      clearInterval(progressInterval);
      const message = err instanceof Error ? err.message : "unknown";
      setResult({
        success: false,
        imported: 0,
        total: totalRows,
        errors: [{ row: 0, reason: "client_network_error", params: { message } }],
      });
      setPhase("done");
    }
  }, [csvRaw, totalRows]);

  /* ---- Reset ---- */

  const handleReset = useCallback(() => {
    setPhase("idle");
    setCsvRaw("");
    setFileName("");
    setHeaders([]);
    setPreviewRows([]);
    setTotalRows(0);
    setProgress(0);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  /* ---- Column badge styling ---- */

  const colBadge = (col: string) => {
    const isExpected = EXPECTED_COLUMNS.includes(col);
    return isExpected
      ? "bg-neutral-100 text-neutral-900 border-neutral-100"
      : "bg-amber-50 text-amber-700 border-amber-200";
  };

  /* ---- Missing columns warning ---- */
  const missingCols = EXPECTED_COLUMNS.filter((c) => !headers.includes(c));

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Link
            href="/admin/marketplace"
            className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 hover:text-slate-900 transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("marketplace")}
          </Link>
          <h1 className="text-3xl font-black text-slate-900">{t("pageTitle")}</h1>
          <p className="mt-2 text-slate-500">
            {t.rich("pageSubtitle", {
              code: (chunks) => <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded font-mono">{chunks}</code>,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </div>
      </div>

      {/* ======================== IDLE — Drop Zone ======================== */}
      {phase === "idle" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`
            relative cursor-pointer rounded-2xl border-2 border-dashed p-16
            flex flex-col items-center justify-center gap-4
            transition-all duration-300 ease-out
            ${
              dragActive
                ? "border-orange-400 bg-orange-50/60 shadow-[0_0_40px_rgba(251,146,60,0.15)] scale-[1.01]"
                : "border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50/50"
            }
          `}
        >
          <div
            className={`
              rounded-2xl p-5 transition-all duration-300
              ${dragActive ? "bg-orange-100 text-orange-600" : "bg-slate-100 text-slate-400"}
            `}
          >
            <Upload className="w-10 h-10" />
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-slate-700">
              {dragActive ? t("dropHere") : t("dragDrop")}
            </p>
            <p className="mt-1 text-sm text-slate-400">{t("orClickToSelect")}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800 transition-colors">
            <FileSpreadsheet className="w-4 h-4" />
            {t("selectCsvFile")}
          </span>
          <input ref={inputRef} type="file" accept=".csv" onChange={handleFileInput} className="hidden" />
        </div>
      )}

      {/* ======================== PREVIEW ======================== */}
      {phase === "preview" && (
        <div className="space-y-6">
          {/* File info */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <FileSpreadsheet className="w-5 h-5 text-orange-500" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900 truncate">{fileName}</p>
              <p className="text-xs text-slate-500">
                {t("rowsDetected", { count: totalRows })} &middot; {t("columnsDetected", { count: headers.length })}
              </p>
            </div>
            <button
              onClick={handleReset}
              className="ml-auto text-xs font-bold text-slate-500 hover:text-red-600 transition-colors"
            >
              {t("changeFile")}
            </button>
          </div>

          {/* Column mapping badges */}
          <div className="flex flex-wrap gap-2">
            {headers.map((h) => (
              <span
                key={h}
                className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-bold ${colBadge(h)}`}
              >
                {h}
              </span>
            ))}
          </div>

          {/* Missing columns warning */}
          {missingCols.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-amber-800">{t("missingColumns")}</p>
                <p className="text-xs text-amber-700 mt-1">
                  {missingCols.map((c) => (
                    <code key={c} className="bg-amber-100 px-1 py-0.5 rounded mr-1 font-mono">
                      {c}
                    </code>
                  ))}
                  — {t.rich("missingColumnsHint", { strong: (chunks) => <strong>{chunks}</strong> })}
                </p>
              </div>
            </div>
          )}

          {/* Preview table */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                {t("previewOfTotal", { shown: previewRows.length, total: totalRows })}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-bold text-slate-500 text-xs">#</th>
                    {headers.map((h) => (
                      <th key={h} className="px-4 py-3 font-bold text-slate-700 text-xs whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previewRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{idx + 2}</td>
                      {headers.map((h) => (
                        <td key={h} className="px-4 py-3 text-slate-700 max-w-[240px] truncate">
                          {row[h] || <span className="text-slate-300">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Import button */}
          <div className="flex items-center gap-4">
            <button
              onClick={handleImport}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-6 py-3.5 text-sm font-black text-white hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20 hover:shadow-orange-500/30 active:scale-[0.98]"
            >
              <Upload className="w-4 h-4" />
              {t("importCount", { count: totalRows })}
            </button>
            <button
              onClick={handleReset}
              className="rounded-xl border border-slate-200 bg-white px-5 py-3.5 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* ======================== IMPORTING — Progress ======================== */}
      {phase === "importing" && (
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-slate-200 bg-white p-12 shadow-sm">
          <Loader2 className="w-10 h-10 text-orange-500 animate-spin" />
          <div className="text-center">
            <p className="text-lg font-bold text-slate-900">{t("importing")}</p>
            <p className="text-sm text-slate-500 mt-1">{t("productsQueued", { count: totalRows })}</p>
          </div>

          {/* Progress bar */}
          <div className="w-full max-w-md">
            <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500 transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-slate-400 text-center mt-2">{Math.round(progress)}%</p>
          </div>
        </div>
      )}

      {/* ======================== DONE — Report ======================== */}
      {phase === "done" && result && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-neutral-100 bg-neutral-100 p-6">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-neutral-900" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-900">{t("importedSuccessfully")}</p>
                  <p className="text-3xl font-black text-neutral-900 mt-1">{result.imported}</p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
              <div className="flex items-center gap-3">
                <XCircle className="w-6 h-6 text-red-500" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-red-600">{t("errors")}</p>
                  <p className="text-3xl font-black text-red-800 mt-1">{result.errors.length}</p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="w-6 h-6 text-slate-400" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{t("totalRows")}</p>
                  <p className="text-3xl font-black text-slate-900 mt-1">{result.total}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Full progress bar (100%) */}
          <div className="w-full">
            <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  result.errors.length === 0
                    ? "bg-gradient-to-r from-neutral-700 to-neutral-700"
                    : "bg-gradient-to-r from-orange-400 to-orange-500"
                }`}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          {/* Error table */}
          {result.errors.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-red-200 bg-white shadow-sm">
              <div className="px-5 py-3 border-b border-red-100 bg-red-50">
                <p className="text-xs font-black uppercase tracking-[0.12em] text-red-600">
                  {t("errorDetails", { count: result.errors.length })}
                </p>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 font-bold text-slate-700 text-xs">{t("thRow")}</th>
                      <th className="px-4 py-3 font-bold text-slate-700 text-xs">{t("thReason")}</th>
                      <th className="px-4 py-3 font-bold text-slate-700 text-xs">{t("thProductTitle")}</th>
                      <th className="px-4 py-3 font-bold text-slate-700 text-xs">{t("thPrice")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.errors.map((err, idx) => (
                      <tr key={idx} className="hover:bg-red-50/40 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{err.row}</td>
                        <td className="px-4 py-3 text-red-700 text-xs font-semibold">{t(`error.${err.reason}`, err.params)}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs truncate max-w-[200px]">
                          {err.data?.title || "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{err.data?.price || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-4">
            <Link
              href="/admin/marketplace"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              {t("backToMarketplace")}
            </Link>
            <button
              onClick={handleReset}
              className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              {t("newImport")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
