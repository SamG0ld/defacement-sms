import { SignStatusSyncProvider } from "./_sync/provider";
import { StatusQueuePanel } from "./_sync/QueuePanel";

// Mount point for the durable status-change queue (M11 #2). Wrapping the whole
// /signs subtree — list AND detail — in one provider means a single outbox + sync
// loop backs every status control, and the queue banner shows the same state
// wherever the user is. Server component rendering the client provider; the
// provider touches IndexedDB only in effects, so this is SSR-safe.
export default function SignsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SignStatusSyncProvider>
      <div className="space-y-4">
        <StatusQueuePanel />
        {children}
      </div>
    </SignStatusSyncProvider>
  );
}
