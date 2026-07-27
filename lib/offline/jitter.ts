// Reconnect / sync-interval jitter for the offline engines. A DEF CON venue's RF
// is adversarial: a network blip drops many devices at once, and without jitter
// they all fire `syncNow` the instant they reconnect — a synchronized burst that
// can exhaust the small (max:3) serverless pg pool and cascade into 5xx. A small
// random spread decorrelates them. (#80)

// A non-negative integer delay in [0, maxMs). `rand` is injectable for tests.
export function jitterMs(maxMs = 5000, rand: () => number = Math.random): number {
  return Math.floor(rand() * maxMs);
}
