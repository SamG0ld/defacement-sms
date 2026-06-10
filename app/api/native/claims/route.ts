import { claimRequestSchema } from "@/lib/deploy/contract";
import { requireApiSession, runApi } from "@/lib/deploy/api-session";
import { claimSigns } from "@/lib/deploy/service";

// POST /api/native/claims — batch-claim sorted signs for a crew (exclusive lock).
// Returns granted ids + a rejected list (already_claimed / not_sorted /
// not_found). Idempotent: re-claiming signs this crew already holds re-grants
// them.
export async function POST(req: Request): Promise<Response> {
  return runApi(async () => {
    const actor = await requireApiSession();
    const input = claimRequestSchema.parse(await req.json());
    return claimSigns(input, actor);
  });
}
