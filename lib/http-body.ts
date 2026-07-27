// Bounded request/response body reader.
//
// Three call sites (the CSP report collector, the native JSON guards, and the
// Figma render download) each declared a byte cap but reached it by calling
// req.text() / req.json() / res.arrayBuffer() FIRST and checking the length
// afterwards — so the cap only ever described what was already in memory
// (#200, #239, #250). A Content-Length pre-check doesn't close that: it's
// sender-supplied and simply absent under chunked transfer-encoding.
//
// readBoundedBytes reads the stream chunk by chunk and stops the moment the
// running total crosses the budget, so an oversized body is never fully
// buffered. Pure — no imports — so the same function runs in the Edge runtime,
// in Node, and under vitest.

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit.`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

// A byte cap alone doesn't bound the loop: a stream can emit unlimited
// ZERO-length chunks, which never advance `total` and so never trip the cap
// while `chunks` grows without bound (an OOM in the very function whose job is
// to prevent one). Zero-length chunks are skipped, and this is the belt for
// anything else pathological — a stream of 1-byte chunks against a 10MB cap is
// ~10M reads, so a generous ceiling relative to the cap still catches a
// degenerate producer long before it costs real time.
const MIN_CHUNK_BUDGET = 1024;
const CHUNK_BUDGET_DIVISOR = 512;

const EMPTY = new Uint8Array(0);

// Read `body` into bytes, throwing BodyTooLargeError as soon as more than
// `maxBytes` have accumulated. `maxBytes` is inclusive — a body of exactly
// maxBytes is accepted. A null body (no request/response payload) reads as
// empty. Callers map the error to their own status code (413 / a domain error).
//
// Peak memory is ~2x maxBytes at the moment of reassembly (the chunk list and
// the output buffer coexist); chunk references are dropped as they're copied to
// keep that window as short as possible.
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  // A NaN/undefined cap would fail OPEN — `total > NaN` is always false, so the
  // bound would silently vanish. Refuse rather than read unbounded.
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      `readBoundedBytes: maxBytes must be a non-negative finite number (got ${maxBytes}).`,
    );
  }
  if (!body) return new Uint8Array(0);

  const chunkBudget = Math.max(
    MIN_CHUNK_BUDGET,
    Math.ceil(maxBytes / CHUNK_BUDGET_DIVISOR),
  );
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Skip empty chunks rather than counting them: they carry no bytes, so
      // they must not consume the chunk budget either.
      if (!value || value.byteLength === 0) continue;

      chunkCount += 1;
      total += value.byteLength;
      if (total > maxBytes || chunkCount > chunkBudget) {
        // Abort before this chunk joins `chunks`. cancel() is best-effort — a
        // failure to tear the stream down must not mask the size verdict.
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    // Release the lock so the caller can still cancel/inspect the body. Safe to
    // call after cancel(); throws only if the reader is already released.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
    // Drop the reference as soon as it's copied so the chunk can be collected
    // while the rest of the reassembly runs.
    chunks[i] = EMPTY;
  }
  return out;
}
