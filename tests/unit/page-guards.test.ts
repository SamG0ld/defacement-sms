import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/app/generated/prisma/client";

// getSession is the only data dependency; redirect halts execution by throwing
// (mirroring next/navigation's real behavior) so we can assert both the target
// and that the guard stops. @/lib/auth is mocked only to keep the rbac import
// (which pulls hasRole) from instantiating NextAuth — hasRole itself runs for real.
const getSessionMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("@/lib/session", () => ({ getSession: () => getSessionMock() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { requirePageRole, requirePageSession } from "@/lib/page-guards";

function fakeSession(role: UserRole, isActive = true) {
  return { user: { id: "u1", role, isActive } };
}

afterEach(() => {
  getSessionMock.mockReset();
  redirectMock.mockClear();
});

describe("requirePageSession", () => {
  it("returns the session for an authenticated, active user", async () => {
    getSessionMock.mockResolvedValue(fakeSession("volunteer"));
    await expect(requirePageSession()).resolves.toMatchObject({
      user: { role: "volunteer" },
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when there is no session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requirePageSession()).rejects.toThrow("REDIRECT:/login");
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login when the session is deactivated (kill-switch)", async () => {
    getSessionMock.mockResolvedValue(fakeSession("admin", false));
    await expect(requirePageSession()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requirePageRole", () => {
  it("returns the session when the role rank is sufficient", async () => {
    getSessionMock.mockResolvedValue(fakeSession("admin"));
    await expect(requirePageRole("lead")).resolves.toMatchObject({
      user: { role: "admin" },
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("bounces an under-privileged user to / by default", async () => {
    getSessionMock.mockResolvedValue(fakeSession("volunteer"));
    await expect(requirePageRole("admin")).rejects.toThrow("REDIRECT:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("honors a custom fallback target", async () => {
    getSessionMock.mockResolvedValue(fakeSession("volunteer"));
    await expect(requirePageRole("lead", "/signs")).rejects.toThrow(
      "REDIRECT:/signs",
    );
  });

  it("sends an unauthenticated user to /login (not the role fallback)", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requirePageRole("admin", "/signs")).rejects.toThrow(
      "REDIRECT:/login",
    );
  });
});
