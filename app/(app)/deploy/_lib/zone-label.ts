import type { DeploySignView } from "@/lib/deploy/contract";

// How a sign's zone reads on the floor. Crews know zones by their CODE ("LVCC-L1",
// "A1") — the internal Zone.id means nothing to anyone holding a sign, so this
// never renders the FK when a code is available (#190).
//
// Shared because the sign list and the desktop focus pane both show it and had
// already drifted into two copies of the same one-liner.

type ZoneFields = Pick<DeploySignView, "zoneId" | "zoneCode">;

export function zoneLabel(s: ZoneFields): string {
  if (!s.zoneId) return "Unzoned";
  // zoneCode comes through the zone relation, so a zoned sign always has one —
  // the id fallback is belt-and-braces so a label is never blank.
  return `Zone ${s.zoneCode ?? s.zoneId}`;
}
