"use client";

export default function ResetConsentButton() {
  return (
    <button
      type="button"
      onClick={() => {
        try {
          localStorage.removeItem("swypik_cookie_consent");
        } catch {
          /* noop */
        }
        if (typeof window !== "undefined") window.location.reload();
      }}
      className="inline-flex items-center px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium text-sm"
    >
      Modifică preferințele
    </button>
  );
}
