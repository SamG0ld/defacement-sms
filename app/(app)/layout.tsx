import { redirect } from "next/navigation";

import { signOut } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getDeviceHint } from "@/lib/device-server";
import { hasRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { DeviceProvider } from "@/app/_components/DeviceProvider";

import { AppShell } from "./_components/AppShell";
import { NAV } from "./_components/nav";

type DeployTelemetry = { deployed: number; total: number; pct: number };

// The desktop top-strip DEPLOY readout is ambient telemetry shown on every screen,
// so it runs on every authenticated request. A short server-instance memo (same
// pattern as the signs-list signType scan) keeps that off the hot path — the
// readout being up to 30s stale is fine for a fleet progress number.
let deployMemo: { value: DeployTelemetry; expires: number } | null = null;

async function getDeployTelemetry(): Promise<DeployTelemetry> {
  if (deployMemo && Date.now() < deployMemo.expires) return deployMemo.value;
  const statusGroups = await prisma.sign.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const total = statusGroups.reduce((acc, g) => acc + g._count._all, 0);
  const deployed = statusGroups
    .filter((g) => g.status === "deployed" || g.status === "installed")
    .reduce((acc, g) => acc + g._count._all, 0);
  const value: DeployTelemetry = {
    deployed,
    total,
    pct: total ? Math.round((deployed / total) * 100) : 0,
  };
  deployMemo = { value, expires: Date.now() + 30_000 };
  return value;
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user?.id || !session.user.isActive) {
    redirect("/login");
  }

  // Seed the device context from the cookie so the shell renders the right
  // chrome on first paint (no flash); the client corrects it after hydration.
  const device = await getDeviceHint();

  // Role-gate the nav on the SERVER so items a user can't reach never ship to
  // their browser; the client shell just renders the subset it's handed.
  const nav = NAV.filter((n) => hasRole(session.user.role, n.minRole));

  // Overall deploy progress for the desktop top-strip readout (memoized; see
  // getDeployTelemetry). "deployed" = the two up terminals (deployed + installed).
  const deploy = await getDeployTelemetry();

  // Inline server action handed to the client shell so sign-out stays server-side
  // (the shell is a client component and can't define one itself).
  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <DeviceProvider initialDevice={device}>
      <AppShell
        nav={nav}
        role={session.user.role}
        email={session.user.email ?? ""}
        signOutAction={signOutAction}
        deploy={deploy}
      >
        {children}
      </AppShell>
    </DeviceProvider>
  );
}
