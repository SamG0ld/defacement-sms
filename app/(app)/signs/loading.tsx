import { Skeleton } from "@/app/_components/Skeleton";

// Route-level loading fallback for the signs list. Also inherited by signs
// children (`[id]`, import, generate, …) that lack their own loading.tsx — a
// list-shaped placeholder is an acceptable generic there; a detail-page skeleton
// can be added later if a slow detail load warrants it. Device-neutral row blocks
// read as either the desktop table or the mobile cards (loading.tsx is a server
// component, so it can't branch on useDevice()). Renders inside AppShell.
export default function SignsLoading() {
  return (
    <div className="space-y-5">
      {/* Header + actions */}
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-40" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24" />
          ))}
        </div>
      </div>

      {/* Telemetry panel */}
      <div className="panel space-y-3" style={{ padding: "15px 18px" }}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-full" />
      </div>

      {/* Status filter chips ("All" + one per status) */}
      <div className="flex gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>

      {/* List rows */}
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
