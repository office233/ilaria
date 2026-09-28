"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createUploadController } from "./upload-controller";
import { useProcessingStatus } from "./useProcessingStatus";
export type { Trim, UploadState } from "./upload-controller";

/** React adapter for the cancellation-safe upload lifecycle. */
export function useUploadController() {
  const [controller] = useState(createUploadController);
  const { state, session, trimConfirmed, pollKey } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const status = useProcessingStatus(session?.sessionId ?? null, state.kind === "processing", pollKey);
  useEffect(() => { if (status) controller.processingStatus(status); }, [controller, status]);
  const busy = state.kind === "starting" || state.kind === "uploading" || state.kind === "completing";
  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { state, session, status, trimConfirmed, start: controller.start, resume: controller.resume, attach: controller.attach,
    cancel: controller.cancel, retry: controller.retry, confirmTrim: controller.confirmTrim, busy };
}
export type UploadController = ReturnType<typeof useUploadController>;
