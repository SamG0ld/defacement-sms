// #267: /signs/by-size is the per-size record that drives print-run decisions, and
// it was the odd one out — both CSV exports drop `isTestData` rows (#225) and so
// does the reconcile manifest (_manifest.ts), but the view counted them. On
// staging that read "383 active" against 382 real rows + 1 test row: a wrong print
// count. Asserted at the page level because the query IS the fix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import BySizePage from "@/app/(app)/signs/by-size/page";

// Flatten every text node in the (server-rendered) element tree. Nothing is
// actually rendered — no hook runs — so the client ManifestPanel stays inert,
// same approach as tests/integration/deploy-page.test.ts.
function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props) textOf(el.props.children, out);
  return out;
}

const SIZE = "22x28";

function seedSign(over: Record<string, unknown>) {
  return prisma.sign.create({
    data: {
      signText: "Poster",
      signType: '22"x28"',
      size: SIZE,
      ...over,
    } as never,
  });
}

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("/signs/by-size record counts", () => {
  it("excludes isTestData rows from the header count and the size bucket", async () => {
    await seedSign({ itemId: "R-1", status: "pending" });
    await seedSign({ itemId: "R-2", status: "pending" });
    await seedSign({ itemId: "T-1", status: "pending", isTestData: true });

    const text = textOf(await BySizePage()).join("");
    expect(text).toContain("2 active");
    expect(text).not.toContain("3 active");
    // The per-size bucket badge tallies the same rows.
    expect(text).toContain("Pending 2");
  });

  it("still excludes archived rows (buildSignWhere), so the two filters compose", async () => {
    await seedSign({ itemId: "R-3", status: "pending" });
    await seedSign({ itemId: "RM-1", status: "archived" });
    await seedSign({ itemId: "T-2", status: "pending", isTestData: true });

    const text = textOf(await BySizePage()).join("");
    expect(text).toContain("1 active");
    expect(text).toContain("Pending 1");
    expect(text).not.toContain("Removed");
  });
});
