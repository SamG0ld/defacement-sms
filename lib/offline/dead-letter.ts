// Bounded dead-letter retention, shared by both offline queues (the /deploy floor
// tool and the /signs status queue). (#207)
//
// A dead-lettered entry is a permanent failure the user has to see and discard by
// hand. Nothing prunes them, so on a SHARED floor device used by many volunteers
// across a multi-day con they accumulate in IndexedDB forever — and because both
// queues getAll() + sort the ENTIRE store on every 20s tick, focus and reconnect,
// the per-tick cost grows with the pile.
//
// The bound is a COUNT, deliberately not a TTL. A failed entry is often the only
// record that a volunteer's action was refused, and they may never have opened
// the queue panel to see it; deleting on age would make evidence from day 1 of a
// con vanish before a lead reviews it on day 4. Capping by count bounds the
// growth (which is the actual defect) while guaranteeing the most recent failures
// — the ones anyone is still acting on — always survive.
export const MAX_DEAD_LETTERS = 200;

// Given the dead-lettered entries, return the ones to DELETE: oldest first, only
// those beyond the cap. Pure — the caller owns the IndexedDB writes (and, for the
// deploy queue, any photo bytes hanging off them).
export function prunableDeadLetters<T>(
  failed: readonly T[],
  createdAt: (entry: T) => number,
  cap: number = MAX_DEAD_LETTERS,
): T[] {
  if (failed.length <= cap) return [];
  return [...failed]
    .sort((a, b) => createdAt(a) - createdAt(b))
    .slice(0, failed.length - cap);
}
