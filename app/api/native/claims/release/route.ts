import { releaseRequestSchema } from "@/lib/deploy/contract";
import {
  readJsonBody,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { hasRole } from "@/lib/rbac";
import { releaseSigns } from "@/lib/deploy/service";

// POST /api/native/claims/release — drop a claim lock. A crew releases its own
// claims; a lead+/admin may force-release any claim (a crew that left the floor
// without releasing).
export async function POST(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    const input = releaseRequestSchema.parse(await readJsonBody(req));
    const force = hasRole(actor.role, "lead");
    return releaseSigns(input, actor, force);
  });
}
