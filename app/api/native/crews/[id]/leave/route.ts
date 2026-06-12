import { apiError, requireApiSession, runApi } from "@/lib/deploy/api-session";
import { leaveCrew } from "@/lib/deploy/service";

// POST /api/native/crews/[id]/leave — leave a crew.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const crewId = Number.parseInt(id, 10);
  if (!Number.isInteger(crewId) || crewId <= 0) {
    return apiError(400, "invalid crew id");
  }
  return runApi(req, async () => {
    const actor = await requireApiSession();
    await leaveCrew(crewId, actor);
    return { ok: true };
  });
}
