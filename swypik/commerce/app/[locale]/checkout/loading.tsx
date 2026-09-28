import { Skeleton } from "@/components/ui/Skeleton";

export default function CheckoutLoading() {
  return (
    <main className="min-h-dvh bg-canvas px-gutter py-6" aria-busy>
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Skeleton className="h-72 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      </div>
    </main>
  );
}
