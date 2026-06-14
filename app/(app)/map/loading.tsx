import { Skeleton } from "@/app/_components/Skeleton";

// Route-level loading fallback for the Maps page. Cleanly scoped — /map has no
// child routes. Shapes the floor-picker layout: header, a tab row, a large
// floor-image block on the left, and the add-room / rooms-list column on the
// right. Renders inside AppShell, so the nav chrome stays.
export default function MapLoading() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      {/* Manage-floors disclosure bar */}
      <Skeleton className="h-11 w-full rounded-xl" />

      {/* Floor tabs */}
      <div className="flex gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-md" />
        ))}
      </div>

      {/* Floor image + rooms column */}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Skeleton className="aspect-[4/3] w-full rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
