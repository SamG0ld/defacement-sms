import { describe, expect, it } from "vitest";

import { reconcile } from "@/app/(app)/signs/_sync/overlay";
import type {
  StatusOutboxEntry,
  StatusOverlay,
} from "@/app/(app)/signs/_sync/types";

const entry = (over: Partial<StatusOutboxEntry> = {}): StatusOutboxEntry => ({
  clientId: "c1",
  signId: 1,
  status: "deployed",
  changedAt: "2026-08-07T18:00:00.000Z",
  queueStatus: "pending",
  attempts: 0,
  createdAt: 100,
  ...over,
});

describe("reconcile — overlay from outbox + previous overlay", () => {
  it("a pending entry shows queued", () => {
    const out = reconcile({}, [entry({ signId: 5, status: "sorted" })]);
    expect(out[5]).toEqual({ status: "sorted", indicator: "queued" });
  });

  it("a failed entry shows failed", () => {
    const out = reconcile({}, [entry({ signId: 5, queueStatus: "failed" })]);
    expect(out[5]).toEqual({ status: "deployed", indicator: "failed" });
  });

  it("multiple entries for one sign: the last by createdAt wins", () => {
    const out = reconcile({}, [
      entry({ clientId: "a", signId: 5, status: "printed", createdAt: 100 }),
      entry({ clientId: "b", signId: 5, status: "delivered", createdAt: 200 }),
    ]);
    expect(out[5]).toEqual({ status: "delivered", indicator: "queued" });
  });

  it("a queued sign that drained (gone from outbox) becomes sticky synced", () => {
    const prev: StatusOverlay = {
      5: { status: "deployed", indicator: "queued" },
    };
    const out = reconcile(prev, []);
    expect(out[5]).toEqual({ status: "deployed", indicator: "synced" });
  });

  it("a synced sign stays synced across cycles (sticky until reload)", () => {
    const prev: StatusOverlay = {
      5: { status: "deployed", indicator: "synced" },
    };
    const out = reconcile(prev, []);
    expect(out[5]).toEqual({ status: "deployed", indicator: "synced" });
  });

  it("a discarded failed entry (gone from outbox) reverts to server truth", () => {
    const prev: StatusOverlay = {
      5: { status: "deployed", indicator: "failed" },
    };
    const out = reconcile(prev, []);
    expect(out[5]).toBeUndefined();
  });

  it("re-queuing a sign after it synced overrides the sticky synced badge", () => {
    const prev: StatusOverlay = {
      5: { status: "deployed", indicator: "synced" },
    };
    const out = reconcile(prev, [entry({ signId: 5, status: "sorted" })]);
    expect(out[5]).toEqual({ status: "sorted", indicator: "queued" });
  });
});
