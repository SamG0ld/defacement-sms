import { deployRequestSchema } from "@/lib/deploy/contract";
import {
  readJsonBody,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { applyDeploys } from "@/lib/deploy/service";

// Batch writes against the max:3 pool — bound the worst case.
export const maxDuration = 30;

// POST /api/native/deploys — batch deploy events. Each event is idempotent on
// clientId and classified applied | duplicate | conflict. Photos upload
// separately (see deploys/[clientId]/photo) and never block this.
export async function POST(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    const input = deployRequestSchema.parse(await readJsonBody(req));
    return applyDeploys(input, actor);
  });
}
