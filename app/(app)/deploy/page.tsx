import { requireSession } from "@/lib/rbac";

import { DeployApp } from "./_components/DeployApp";

// Field deployment tool — the installable PWA's home (manifest start_url). Lives
// under (app) so the same auth gate as the rest of the app applies. The server
// only resolves the session here; all floor state is client-side and offline-
// first (see _lib/store.ts), fed by the /api/native/* JSON API.
export default async function DeployPage() {
  const session = await requireSession();

  return <DeployApp currentUserId={session.user.id} />;
}
