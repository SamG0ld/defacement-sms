import { createCrewSchema } from "@/lib/deploy/contract";
import {
  readJsonBody,
  requireApiSession,
  runApi,
} from "@/lib/deploy/api-session";
import { createCrew } from "@/lib/deploy/service";

// POST /api/native/crews — start a crew on the floor (self-serve). The creator
// becomes the first member. Any active user may create a crew.
export async function POST(req: Request): Promise<Response> {
  return runApi(req, async () => {
    const actor = await requireApiSession();
    const input = createCrewSchema.parse(await readJsonBody(req));
    return createCrew(input, actor);
  });
}
