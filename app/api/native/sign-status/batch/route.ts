import { setSignStatusBatchSchema } from "@/lib/deploy/contract";
import {
  readJsonBody,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { setSignStatusBatch } from "@/lib/deploy/service";

// Batch writes against the max:3 pool — bound the worst case.
export const maxDuration = 30;

// POST /api/native/sign-status/batch — the /signs offline queue drained in one
// request. Each change is idempotent on clientId and classified applied |
// duplicate | noop | not_found, mirroring the single-change endpoint; the
// results echo clientId so the client resolves entries individually.
export async function POST(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    const input = setSignStatusBatchSchema.parse(await readJsonBody(req));
    return setSignStatusBatch(input, actor);
  });
}
