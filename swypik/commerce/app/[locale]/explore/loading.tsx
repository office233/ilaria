import { getTranslations } from "next-intl/server";

export default async function ExploreLoading() {
  const t = await getTranslations("explore");
  return (
    <main className="fixed inset-0 grid place-items-center bg-black text-white">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" role="status" aria-label={t("loadingAria")} />
    </main>
  );
}
