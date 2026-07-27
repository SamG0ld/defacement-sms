import { describe, expect, it, vi } from "vitest";

// #200/#239/#250: three sites declared a byte cap but buffered the whole body
// first, so the cap only ever ran post-hoc. readBoundedBytes is the shared
// primitive that makes the cap authoritative — it must stop pulling chunks the
// moment the running total exceeds the budget, never after.
import { BodyTooLargeError, readBoundedBytes } from "@/lib/http-body";

// A stream that records how many chunks were actually pulled, so a test can
// prove the read aborted early instead of draining the whole body.
function countingStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulled = 0;
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunks[i]);
      i += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return countingStream(chunks).stream;
}

describe("readBoundedBytes", () => {
  it("returns the concatenated bytes when the body is under the cap", async () => {
    const bytes = await readBoundedBytes(
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]),
      1024,
    );
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts a body exactly at the cap (the cap is inclusive)", async () => {
    const bytes = await readBoundedBytes(streamOf([new Uint8Array(8)]), 8);
    expect(bytes.byteLength).toBe(8);
  });

  it("returns an empty array for a null body", async () => {
    const bytes = await readBoundedBytes(null, 1024);
    expect(bytes.byteLength).toBe(0);
  });

  it("returns an empty array for an empty stream", async () => {
    const bytes = await readBoundedBytes(streamOf([]), 1024);
    expect(bytes.byteLength).toBe(0);
  });

  it("throws BodyTooLargeError once the running total exceeds the cap", async () => {
    await expect(
      readBoundedBytes(streamOf([new Uint8Array(9)]), 8),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("aborts early — later chunks are never pulled, and the stream is cancelled", async () => {
    // 10 chunks of 100 bytes against a 250-byte cap: the 3rd chunk crosses it, so
    // chunks 4-10 must never be requested. This is the whole point of the helper —
    // a post-hoc length check would have buffered all 1000 bytes first.
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(100));
    const { stream, pulled, cancelled } = countingStream(chunks);

    await expect(readBoundedBytes(stream, 250)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(pulled()).toBe(3);
    expect(cancelled()).toBe(true);
  });

  it("releases the reader lock when the body fits", async () => {
    const stream = streamOf([new Uint8Array([1])]);
    await readBoundedBytes(stream, 1024);
    // A still-locked stream would throw here; getReader() succeeding proves the
    // lock was released so the caller can reuse/cancel the body.
    expect(() => stream.getReader()).not.toThrow();
  });

  it("propagates a stream error rather than returning a short read", async () => {
    const boom = new Error("network reset mid-body");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(boom);
      },
    });
    await expect(readBoundedBytes(stream, 1024)).rejects.toThrow(
      /network reset mid-body/,
    );
  });

  it("does not swallow a cancel() failure into a misleading success", async () => {
    // If cancel() rejects while we're already aborting, the caller must still see
    // BodyTooLargeError — the size verdict, not the cleanup noise.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });
    await expect(readBoundedBytes(stream, 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("treats a zero cap as 'no bytes allowed'", async () => {
    await expect(readBoundedBytes(streamOf([new Uint8Array(1)]), 0)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    await expect(readBoundedBytes(streamOf([]), 0)).resolves.toHaveLength(0);
  });
});

// A byte cap alone does NOT bound the read loop. These pin the two ways a
// producer could sidestep it — both of which OOM'd the process before the guard.
describe("readBoundedBytes — loop bounds beyond the byte cap", () => {
  it("skips zero-length chunks instead of looping on them forever", async () => {
    // A finite stream of empty chunks must terminate cleanly, not spin.
    const chunks = [
      new Uint8Array(0),
      new Uint8Array([7]),
      new Uint8Array(0),
      new Uint8Array([8]),
      new Uint8Array(0),
    ];
    await expect(readBoundedBytes(streamOf(chunks), 16)).resolves.toEqual(
      new Uint8Array([7, 8]),
    );
  });

  it("terminates on an ENDLESS stream of zero-length chunks", async () => {
    // Before the guard this never advanced `total`, so the cap never tripped
    // while the chunk array grew unbounded — a hard OOM in the function whose
    // entire job is preventing one.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Interleave one real byte so the loop is exercised, not short-circuited.
        controller.enqueue(pulled % 2 === 0 ? new Uint8Array(1) : new Uint8Array(0));
      },
    });
    await expect(readBoundedBytes(stream, 64)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("rejects a degenerate stream of 1-byte chunks via the chunk budget", async () => {
    // maxBytes 1MB / 512 = a 2048-chunk budget; 1-byte chunks blow that long
    // before they'd blow the byte cap.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1));
      },
    });
    await expect(readBoundedBytes(stream, 1024 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(pulled).toBeLessThan(1024 * 1024);
  });

  it("does not let the chunk budget reject a normal many-chunk body", async () => {
    // 64 x 16KB = 1MB in 64 chunks — well inside both bounds.
    const chunks = Array.from({ length: 64 }, () => new Uint8Array(16 * 1024));
    const bytes = await readBoundedBytes(streamOf(chunks), 1024 * 1024);
    expect(bytes.byteLength).toBe(1024 * 1024);
  });
});

// An unvalidated cap fails OPEN: `total > NaN` is always false, so the bound
// silently disappears. Refuse loudly instead — the obvious next call site is
// readBoundedBytes(req.body, Number(process.env.SOMETHING)).
describe("readBoundedBytes — cap validation", () => {
  it("throws RangeError for a NaN cap rather than reading unbounded", async () => {
    await expect(
      readBoundedBytes(streamOf([new Uint8Array(1)]), Number("oops")),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("throws RangeError for an undefined cap", async () => {
    await expect(
      readBoundedBytes(streamOf([new Uint8Array(1)]), undefined as unknown as number),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("throws RangeError for a negative cap", async () => {
    await expect(
      readBoundedBytes(streamOf([new Uint8Array(1)]), -1),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("throws RangeError for Infinity (an intentional bound, not a bypass)", async () => {
    await expect(
      readBoundedBytes(streamOf([new Uint8Array(1)]), Infinity),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("validates the cap even when the body is null", async () => {
    await expect(readBoundedBytes(null, Number.NaN)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("BodyTooLargeError", () => {
  it("carries the cap it exceeded so callers can build their own message", () => {
    const err = new BodyTooLargeError(1024);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BodyTooLargeError");
    expect(err.maxBytes).toBe(1024);
  });

  it("is distinguishable from a generic Error by instanceof", () => {
    const seen = vi.fn();
    try {
      throw new BodyTooLargeError(1);
    } catch (err) {
      if (err instanceof BodyTooLargeError) seen();
    }
    expect(seen).toHaveBeenCalledOnce();
  });
});
