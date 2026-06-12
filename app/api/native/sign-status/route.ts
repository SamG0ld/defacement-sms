import { setSignStatusSchema } from "@/lib/deploy/contract";
import {
  readJsonBody,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { setSignStatus } from "@/lib/deploy/service";

// POST /api/native/sign-status — a single per-sign status change, idempotent on
// clientId and classified applied | duplicate | noop | not_found. The offline
// counterpart to the updateSignStatus Server Action: the /signs queue drains
// here so a status change made on a flaky floor survives connectivity drops.
export async function POST(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    const input = setSignStatusSchema.parse(await readJsonBody(req));
    return setSignStatus(input, actor);
  });
}
