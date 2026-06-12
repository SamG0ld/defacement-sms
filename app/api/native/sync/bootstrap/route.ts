import { requireApiSession, runApi } from "@/lib/deploy/api-session";
import { bootstrap } from "@/lib/deploy/service";

// GET /api/native/sync/bootstrap — full floor working set (crews, my crews, the
// claimable + deployed signs) + a cursor for subsequent delta pulls. Cold-start
// load for both clients.

// The heaviest native read (full working set) against the max:3 pool.
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    return bootstrap(actor);
  });
}
