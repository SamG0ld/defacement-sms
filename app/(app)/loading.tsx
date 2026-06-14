import { Skeleton } from "@/app/_components/Skeleton";

// Route-level loading fallback for the dashboard (`app/(app)/page.tsx`). Because
// it sits at the `(app)` segment it ALSO doubles as the fallback for any
// authenticated route without its own loading.tsx — so the shape is kept generic
// (header + a gauge panel + a tile grid) rather than pixel-matching the
// dashboard. /signs and /map override it with their own skeletons. Renders inside
// AppShell, so only the content area is replaced; the nav chrome stays.
export default function DashboardLoading() {
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Telemetry gauge panel */}
      <div className="panel space-y-3" style={{ padding: "15px 18px" }}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-2 w-full" />
      </div>

      {/* Status tile grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="panel flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      {/* Urgency tiles */}
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="panel flex flex-col gap-2 p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
