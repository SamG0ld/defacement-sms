import { deployRequestSchema } from "@/lib/deploy/contract";
import { requireApiSession, runApi } from "@/lib/deploy/api-session";
import { applyDeploys } from "@/lib/deploy/service";

// POST /api/native/deploys — batch deploy events. Each event is idempotent on
// clientId and classified applied | duplicate | conflict. Photos upload
// separately (see deploys/[clientId]/photo) and never block this.
export async function POST(req: Request): Promise<Response> {
  return runApi(async () => {
    const actor = await requireApiSession();
    const input = deployRequestSchema.parse(await req.json());
    return applyDeploys(input, actor);
  });
}
