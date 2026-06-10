import { changesQuerySchema } from "@/lib/deploy/contract";
import { requireApiSession, runApi } from "@/lib/deploy/api-session";
import { changes } from "@/lib/deploy/service";

// GET /api/native/sync/changes?since=<ISO> — delta pull of signs changed since a
// prior cursor, for reconciliation after the client reconnects.
export async function GET(req: Request): Promise<Response> {
  return runApi(async () => {
    await requireApiSession();
    const since = new URL(req.url).searchParams.get("since");
    const { since: parsed } = changesQuerySchema.parse({ since });
    return changes(parsed);
  });
}
