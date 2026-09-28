import { Card } from "@/components/ui/Card";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";

export default function EarningsLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="mb-5 space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <Card padding="lg">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-9 w-48" />
        <Skeleton className="mt-4 h-11 w-full sm:w-40" />
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} padding="sm" className={i === 2 ? "col-span-2 lg:col-span-1" : undefined}>
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-7 w-28" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SkeletonText lines={5} />
        </Card>
        <Card>
          <SkeletonText lines={6} />
        </Card>
      </div>
    </div>
  );
}
