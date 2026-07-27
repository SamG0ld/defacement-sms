// #225: HTTP-layer coverage for the two board CSV exports. lib/sign-export.ts's
// serializers are unit-tested; this pins the ROUTE behavior neither of them can see —
// the auth gate and, above all, that `isTestData` signs never reach the CSV. These
// exports are the machine contract the sign-art generators re-import and the print
// handoff is read off, so a test sign in the body is a test sign in the print run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET as flatExport } from "@/app/(app)/signs/export/route";
import { GET as sectionedExport } from "@/app/(app)/signs/export/sectioned/route";

const leadSession = {
  user: { id: "u1", email: "lead@example.com", isActive: true, role: "lead" },
};

function signedIn() {
  vi.mocked(auth).mockResolvedValue(leadSession as never);
}
function signedOut() {
  vi.mocked(auth).mockResolvedValue(null as never);
}

// The two routes take the same query params, so drive both through one helper.
const ROUTES = [
  { name: "/signs/export", url: "http://localhost/signs/export", handler: flatExport },
  {
    name: "/signs/export/sectioned",
    url: "http://localhost/signs/export/sectioned",
    handler: sectionedExport,
  },
] as const;

// One real sign + one imported with "Import as test data" checked (the wizard default).
async function seedRealAndTestSigns() {
  await prisma.sign.create({
    data: {
      itemId: "W100",
      signText: "Aerospace Village",
      signType: '22"x28"',
      size: "22x28",
      status: "generated" as never,
      isTestData: false,
    },
  });
  await prisma.sign.create({
    data: {
      itemId: "TD-01",
      signText: "Import Smoke Test",
      signType: '22"x28"',
      size: "22x28",
      status: "generated" as never,
      isTestData: true,
    },
  });
}

beforeEach(() => vi.mocked(auth).mockReset());
afterEach(() => vi.clearAllMocks());

describe.each(ROUTES)("GET $name", ({ url, handler }) => {
  it("omits isTestData signs from the CSV", async () => {
    await seedRealAndTestSigns();
    signedIn();

    const res = await handler(new NextRequest(url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("W100");
    expect(body).not.toContain("TD-01");
    expect(body).not.toContain("Import Smoke Test");
  });

  it("omits test data even when a status filter is applied", async () => {
    // The exclusion is unconditional — it must survive composition with the list
    // filters the "Export CSV" link carries through.
    await seedRealAndTestSigns();
    signedIn();

    const res = await handler(new NextRequest(`${url}?status=generated`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("W100");
    expect(body).not.toContain("TD-01");
  });

  it("still excludes archived signs (buildSignWhere's default is untouched)", async () => {
    // W100 is the positive control: without it a 403/500 body would satisfy the
    // negative assertion on its own.
    await seedRealAndTestSigns();
    await prisma.sign.create({
      data: {
        itemId: "RM-01",
        signText: "Removed Sign",
        signType: '22"x28"',
        size: "22x28",
        status: "archived" as never,
        isTestData: false,
      },
    });
    signedIn();

    const res = await handler(new NextRequest(url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("W100");
    expect(body).not.toContain("RM-01");
  });

  it("403s a signed-out request", async () => {
    signedOut();
    const res = await handler(new NextRequest(url));
    expect(res.status).toBe(403);
  });

  it("403s a deactivated user (the tokenVersion/isActive kill-switch)", async () => {
    // requireSession rejects on isActive, not just on a present id — these routes
    // hand out the full board, so pin that the revoked-session path really 403s.
    vi.mocked(auth).mockResolvedValue({
      user: { ...leadSession.user, isActive: false },
    } as never);
    const res = await handler(new NextRequest(url));
    expect(res.status).toBe(403);
  });
});
