"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/lib/i18n/navigation";
import { UploadApiError, videoApi, type VideoPatchResult } from "@/lib/upload/api";
import { toVideoPatch, type PublishIntent } from "@/lib/upload/details";
import { createCoverUploader } from "@/lib/upload/cover-upload";
import { detailsDraft } from "@/lib/upload/draft-store";
import { probeVideoFile, type ProbedFile } from "@/lib/upload/media";
import { defaultTrim, trimForServer, type TrimRange } from "@/lib/upload/trim";
import { checkVideoDuration, checkVideoFile } from "@/lib/video/limits";
import { CameraCapture } from "./CameraCapture";
import { DetailsStep } from "./DetailsStep";
import { EditStep } from "./EditStep";
import { PickStep, type ResumeRequest } from "./PickStep";
import { UploadStatusCard } from "./UploadStatusCard";
import { detailsFromVideo, useDetailsForm } from "./useDetailsForm";
import { useErrorText } from "./useErrorText";
import { useUploadController } from "./useUploadController";

type Step = "pick" | "camera" | "edit" | "details";

const STEP_NUMBER: Record<Step, number> = { pick: 1, camera: 1, edit: 2, details: 3 };

/**
 * Fluxul unic de creare video (mobil întâi): alege/filmează → taie + copertă →
 * detalii → publică. Uploadul pornește imediat după alegere și rulează în
 * fundal cât creatorul editează; procesarea pornește după confirmarea tăierii.
 */
export default function CreateFlow(props: {
  initialSource: "pick" | "camera";
  draftVideoId?: string;
  /** Preselectare din /upload?mission=<uuid>. */
  missionId?: string;
  audioTrackId?: number;
}) {
  const t = useTranslations("videoUpload");
  const router = useRouter();
  const { toast } = useToast();
  const errorText = useErrorText();
  const upload = useUploadController();
  const [step, setStep] = useState<Step>(props.draftVideoId ? "details" : props.initialSource === "camera" ? "camera" : "pick");
  const [fromCamera, setFromCamera] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbedFile | null>(null);
  const [trim, setTrim] = useState<TrimRange | null>(null);
  const [cover, setCover] = useState<{ blob: Blob; url: string } | null>(null);
  const [serverCover, setServerCover] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<PublishIntent | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const coverUploader = useRef(createCoverUploader((id, blob) => videoApi.uploadCover(id, blob)));
  const coverAttempt = useRef<{ id: string; blob: Blob } | null>(null);
  const operation = useRef(0);
  const submittingRef = useRef(false);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  // Misiunea deja legată pe server (draft reluat); missionId pleacă doar dacă diferă.
  const missionBaseline = useRef<string | null>(null);
  const videoId = upload.session?.videoId ?? loadedDraftId;
  const form = useDetailsForm(videoId, {
    ...(props.missionId ? { missionId: props.missionId } : {}),
    ...(props.audioTrackId ? { audioTrackId: props.audioTrackId } : {}),
  });

  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  useEffect(() => () => void (cover?.url && URL.revokeObjectURL(cover.url)), [cover?.url]);
  useEffect(() => () => { operation.current += 1; }, []);

  // Draft reluat din /creator/drafts: detaliile și starea vin de pe server.
  useEffect(() => {
    const generation = ++operation.current;
    setLoadedDraftId(null);
    if (!props.draftVideoId) return;
    setStep("pick");
    videoApi
      .get(props.draftVideoId)
      .then((v) => {
        if (generation !== operation.current) return;
        setLoadedDraftId(v.id);
        setStep("details");
        missionBaseline.current = v.mission_id;
        if (!detailsDraft.load(v.id)) form.replace(detailsFromVideo(v));
        // Legătura cu misiunea vine mereu de pe server (draftul local poate fi vechi).
        else if (!props.missionId) form.update("missionId", v.mission_id);
        setServerCover(v.thumbnail_url);
        if (v.session_id) void upload.attach(v.session_id, v.id);
      })
      .catch(() => {
        if (generation !== operation.current) return;
        setLoadedDraftId(null);
        setStep("pick");
        setPickError(errorText("not_found"));
      });
    return () => { operation.current += 1; };
  }, [props.draftVideoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = useCallback(
    async (file: Blob, name: string, source: "gallery" | "camera") => {
      const generation = ++operation.current;
      const problem = checkVideoFile({ name, type: file.type, size: file.size });
      if (problem) return setPickError(errorText(problem === "too_large" ? "file_too_large" : problem === "empty" ? "file_empty" : "unsupported_type"));
      const probed = await probeVideoFile(file);
      if (generation !== operation.current) return;
      if (probed && checkVideoDuration(probed.durationMs) === "too_short") return setPickError(errorText("duration_too_short"));
      setPickError(null);
      setLoadedDraftId(null);
      setCover(null);
      setServerCover(null);
      missionBaseline.current = null;
      setPreviewUrl(URL.createObjectURL(file));
      setProbe(probed);
      setTrim(probed ? defaultTrim(probed.durationMs) : null);
      setFromCamera(source === "camera");
      setStep("edit");
      void upload.start(file, source, name);
    },
    [upload, errorText],
  );

  const resume = useCallback(
    async (req: ResumeRequest) => {
      const generation = ++operation.current;
      if (!req.file) return setPickError(t("pick.resumeNeedsFile"));
      const probed = await probeVideoFile(req.file);
      if (generation !== operation.current) return;
      setPreviewUrl(URL.createObjectURL(req.file));
      setCover(null);
      setServerCover(null);
      setLoadedDraftId(null);
      setPickError(null);
      setFromCamera(false);
      missionBaseline.current = null;
      setProbe(probed);
      setTrim(probed ? defaultTrim(probed.durationMs) : null);
      setStep("edit");
      void upload.resume(req.sessionId, req.videoId, req.file);
    },
    [upload, t],
  );

  // Coperta aleasă se urcă imediat ce există clipul în DB.
  useEffect(() => {
    if (!cover || !videoId) return;
    if (coverAttempt.current?.id === videoId && coverAttempt.current.blob === cover.blob) return;
    coverAttempt.current = { id: videoId, blob: cover.blob };
    const generation = operation.current;
    void coverUploader.current(videoId, cover.blob).catch((err) => {
      if (generation !== operation.current) return;
      toast({ title: errorText(err instanceof UploadApiError ? err.code : null), tone: "danger" });
    });
  }, [cover, videoId, toast, errorText]);

  const goDetails = () => {
    upload.confirmTrim(trimForServer(trim, probe?.durationMs ?? null));
    setStep("details");
  };

  // Detaliile salvate + înscrierea la misiune eșuată → avertisment, nu eroare.
  const patchDetails = async (id: string, intent: PublishIntent, scheduledAt?: string): Promise<VideoPatchResult> => {
    const missionId = form.details.missionId;
    const generation = operation.current;
    try {
      const res = await videoApi.patch(id, toVideoPatch(form.details, intent, scheduledAt, missionBaseline.current));
      if (generation === operation.current) missionBaseline.current = missionId;
      return res;
    } catch (err) {
      if (!(err instanceof UploadApiError) || !err.saved) throw err;
      if (generation === operation.current) toast({ title: t("mission.linkFailed"), description: errorText(err.code), tone: "danger", duration: 8000 });
      return err.saved;
    }
  };

  const submit = async (intent: PublishIntent, scheduledAt?: string) => {
    if (!videoId || submittingRef.current) return;
    if (intent === "draft" ? !canSaveDraft : !canPublish) return;
    submittingRef.current = true;
    const generation = operation.current;
    setSubmitting(intent);
    try {
      if (cover) await coverUploader.current(videoId, cover.blob);
      if (generation !== operation.current) return;
      const res = await patchDetails(videoId, intent, scheduledAt);
      if (generation !== operation.current) return;
      detailsDraft.clear(videoId);
      if (intent === "draft") {
        toast({ title: t("done.draftSaved"), tone: "success" });
        router.push("/creator/drafts");
      } else if (intent === "scheduled") {
        toast({ title: t("done.scheduled"), tone: "success" });
        router.push("/creator/drafts");
      } else {
        const key = res.liveNow ? "done.live" : res.moderationStatus === "pending_review" ? "done.inReview" : "done.processing";
        toast({ title: t(key), tone: "success", duration: 6000 });
        if (res.soundMix === "remixing") toast({ title: t("details.soundRemixing"), tone: "info", duration: 6000 });
        if (res.soundMix === "unavailable") toast({ title: t("details.soundMixUnavailable"), tone: "danger", duration: 8000 });
        router.push(`/video/${videoId}`);
      }
    } catch (err) {
      if (generation !== operation.current) return;
      toast({ title: errorText(err instanceof UploadApiError ? err.code : null), tone: "danger" });
    } finally {
      submittingRef.current = false;
      if (generation === operation.current) setSubmitting(null);
    }
  };

  const cancelAll = async () => {
    const generation = ++operation.current;
    setLoadedDraftId(null);
    void upload.cancel();
    if (generation !== operation.current) return false;
    setPreviewUrl(null);
    setCover(null);
    setServerCover(null);
    setStep("pick");
    return true;
  };

  if (step === "camera") {
    return (
      <CameraCapture
        onCaptured={(blob) => void begin(blob, `clip-${Date.now()}.${blob.type.includes("mp4") ? "mp4" : "webm"}`, "camera")}
        onGallery={() => { operation.current += 1; setStep("pick"); }}
        onClose={() => {
          operation.current += 1;
          if (props.initialSource !== "camera") return setStep("pick");
          // Prima intrare în WebView (deep link / pornire din bara de jos): nu există „înapoi”.
          if (typeof window !== "undefined" && window.history.length <= 1) router.replace("/");
          else router.back();
        }}
      />
    );
  }

  const status = (
    <UploadStatusCard
      state={upload.state}
      status={upload.status}
      trimConfirmed={upload.trimConfirmed}
      onCancel={() => void cancelAll()}
      onRetry={() => void upload.retry()}
    />
  );
  const failedUpload = upload.state.kind === "failed" && upload.state.stage === "upload";
  // Publicarea cere fișierul complet urcat (procesarea poate fi încă în curs);
  // draftul se poate salva doar când nu mai urcăm (navigarea ar opri uploadul).
  const kind = upload.state.kind;
  const canPublish = Boolean(videoId) && (kind === "processing" || kind === "ready");
  const canSaveDraft = Boolean(videoId) && !upload.busy && kind !== "cancelled" && !failedUpload;

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        back={step === "pick" ? true : undefined}
        menu={false}
        title={t(`steps.${step}`)}
        subtitle={t("stepOf", { n: STEP_NUMBER[step], total: 3 })}
        actions={
          step === "edit" ? (
            <IconButton label={t("discard.open")} onClick={() => setDiscardOpen(true)}>
              <X aria-hidden />
            </IconButton>
          ) : undefined
        }
      />
      <Dialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("discard.title")}
        description={t("discard.body")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDiscardOpen(false)}>
              {t("discard.keep")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscardOpen(false);
                void cancelAll();
              }}
            >
              {t("discard.confirm")}
            </Button>
          </>
        }
      />
      {step === "pick" ? (
        <PickStep onRecord={() => { operation.current += 1; setStep("camera"); }} onPicked={(f) => void begin(f, f.name, "gallery")} onResume={(r) => void resume(r)} error={pickError} />
      ) : null}
      {step === "edit" && previewUrl ? (
        <EditStep
          previewUrl={previewUrl}
          probe={probe}
          trim={trim}
          onTrim={setTrim}
          coverUrl={cover?.url ?? null}
          onCover={(blob) => setCover({ blob, url: URL.createObjectURL(blob) })}
          onRetake={fromCamera ? () => void cancelAll().then((cancelled) => { if (cancelled) setStep("camera"); }) : null}
          onNext={goDetails}
          status={status}
        />
      ) : null}
      {step === "details" ? (
        <DetailsStep
          details={form.details}
          update={form.update}
          videoId={videoId}
          coverUrl={cover?.url ?? serverCover}
          durationSec={probe ? Math.round(((trim?.endMs ?? probe.durationMs) - (trim?.startMs ?? 0)) / 1000) : null}
          processingReady={upload.state.kind === "ready"}
          canPublish={canPublish}
          canSaveDraft={canSaveDraft}
          submitting={submitting}
          onSubmit={(intent, at) => void submit(intent, at)}
          status={status}
        />
      ) : null}
    </div>
  );
}
