// Pure helper for the /deploy overview. The desktop zone gauge is deliberately
// zone-scoped — signs with no zone are dropped from its numerator/denominator (by
// con time every sign should be zoned). That makes its DEPLOY x/y differ from the
// fleet-wide top-strip readout, which counts every sign. To keep the gap honest
// and self-explaining, the overview surfaces how many signs are unzoned, computed
// here WITHOUT touching the zone-progress math the page already does.
//
// Takes the same groupBy(["zoneId","status"]) rows the page fetches; sums the
// _count of the rows whose zoneId is null.
export function countUnzonedSigns(
  rows: { zoneId: number | null; _count: { _all: number } }[],
): number {
  return rows
    .filter((r) => r.zoneId === null)
    .reduce((sum, r) => sum + r._count._all, 0);
}
