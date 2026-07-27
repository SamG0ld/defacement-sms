// Client-safe intake bounds (actions.ts is "use server" and may only export
// async functions, so shared constants live here).

// Hard cap per batch (design decision 2026-07-07): covers any real vendor
// list while keeping the transaction and the review table small.
export const MAX_SPECIALTY_ROWS = 50;
