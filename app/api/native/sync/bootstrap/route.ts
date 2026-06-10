import { requireApiSession, runApi } from "@/lib/deploy/api-session";
import { bootstrap } from "@/lib/deploy/service";

// GET /api/native/sync/bootstrap — full floor working set (crews, my crews, the
// claimable + deployed signs) + a cursor for subsequent delta pulls. Cold-start
// load for both clients.
export async function GET(): Promise<Response> {
  return runApi(async () => {
    const actor = await requireApiSession();
    return bootstrap(actor);
  });
}
