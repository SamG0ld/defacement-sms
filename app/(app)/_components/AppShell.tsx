"use client";

// Device-adaptive app shell. Reads the device context (Phase 1) and renders the
// right CHROME around the server-rendered page (passed as `children`):
//   • mobile  → bottom tab bar + a "More" bottom sheet, full-bleed, safe-area aware
//   • desktop → left sidebar (grouped nav) + console top strip
// Navigation is REAL routing — nav items are <Link>s and the active item derives
// from usePathname(); there is no client-side screen state. Pages stay server
// components; only this chrome is a client component. Role gating uses the real
// session role passed from the server layout; the covert-ops console styling
// lives in globals.css (chrome classes), keyed off [data-chrome].

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { UserRole } from "@/app/generated/prisma/client";
import { useDevice } from "@/app/_components/DeviceProvider";
import { Icons, type IconName } from "@/app/_components/Icons";
import { SignOutButton } from "@/app/_components/SignOutButton";
import { GROUPS, SCREEN_LABEL, type NavEntry } from "./nav";

type DeployTelemetry = { deployed: number; total: number; pct: number };

type ShellProps = {
  nav: NavEntry[]; // already role-filtered by the server layout
  role: UserRole;
  email: string;
  signOutAction: () => Promise<void>;
  deploy: DeployTelemetry; // overall deploy progress, for the desktop top strip
  children: React.ReactNode;
};

const pad3 = (n: number) => String(n).padStart(3, "0");

// Two-letter handle from the email local-part, for the account avatar.
function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  return (local.slice(0, 2) || "··").toLowerCase();
}

// Live Las Vegas (Pacific) clock for the desktop top strip — matches the app's
// "show floor runs on Vegas time" convention.
function VegasClock() {
  const [now, setNow] = useState("");
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date()),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono">
      {now} <span style={{ color: "var(--zinc-600)" }}>PT</span>
    </span>
  );
}

// Real online/offline state for the top-strip "LINK" indicator (the field tool
// lives on flaky RF, so this is genuine telemetry, not decoration).
function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function AppShell({
  nav,
  role,
  email,
  signOutAction,
  deploy,
  children,
}: ShellProps) {
  const { isMobile } = useDevice();
  const pathname = usePathname();
  const activeId =
    nav.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"))
      ?.id ?? null;

  const shared = { activeId, email, role, signOutAction, children };
  return isMobile ? (
    <MobileShell {...shared} visible={nav} />
  ) : (
    <DesktopShell {...shared} visible={nav} deploy={deploy} />
  );
}

type InnerProps = {
  visible: NavEntry[];
  activeId: IconName | null;
  email: string;
  role: UserRole;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
};

// ── MOBILE ──────────────────────────────────────────────────────────────────
function MobileShell({
  visible,
  activeId,
  email,
  role,
  signOutAction,
  children,
}: InnerProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = visible.filter((n) => n.group === "primary");
  const moreItems = visible.filter((n) => n.group !== "primary");
  const inMore = moreItems.some((m) => m.id === activeId);

  // When the More sheet opens, move focus into it and let Escape close it, so
  // keyboard / screen-reader users can operate it as a modal dialog.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  return (
    <div
      data-chrome="scanlines"
      className="relative flex h-dvh flex-col overflow-hidden bg-base"
    >
      {/* top safe-area clearance — no header by design (installed-app feel) */}
      <div
        className="flex-none"
        style={{ height: "env(safe-area-inset-top)" }}
      />

      {/* active screen */}
      <div className="scroll min-h-0 flex-1">
        <div className="px-4 py-4">{children}</div>
      </div>

      {/* More sheet */}
      {moreOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="sheet-backdrop"
            onClick={() => setMoreOpen(false)}
          />
          <div
            ref={sheetRef}
            tabIndex={-1}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More"
          >
            <div className="grip" />
            <div className="px-2 pb-2">
              <span className="prompt">MORE</span>
            </div>
            {moreItems.map((m) => {
              const I = Icons[m.id];
              return (
                <Link
                  key={m.id}
                  href={m.href}
                  onClick={() => setMoreOpen(false)}
                  className={"sheet-row" + (activeId === m.id ? " active" : "")}
                >
                  <I />
                  <span>{m.label}</span>
                  <Icons.chevron
                    width={16}
                    height={16}
                    style={{ marginLeft: "auto", color: "var(--zinc-600)" }}
                  />
                </Link>
              );
            })}

            {/* account */}
            <div
              className="mt-3 flex items-center gap-3 rounded-[11px] border p-3"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
              }}
            >
              <div className="acct-avatar">{initials(email)}</div>
              <div className="min-w-0 flex-1">
                <div className="acct-email">{email}</div>
                <div className="mt-[3px]">
                  <span className="rolechip">{role}</span>
                </div>
              </div>
              <form action={signOutAction}>
                <SignOutButton className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-300 hover:text-zinc-100">
                  <Icons.signout width={16} height={16} />
                </SignOutButton>
              </form>
            </div>
          </div>
        </>
      )}

      {/* bottom tab bar (chrome) */}
      <nav className="tabbar chrome">
        {primary.map((p) => {
          const I = Icons[p.id];
          return (
            <Link
              key={p.id}
              href={p.href}
              className={"tab" + (activeId === p.id ? " active" : "")}
            >
              <I />
              <span className="tl">{p.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={"tab" + (moreOpen || inMore ? " active" : "")}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <Icons.more />
          <span className="tl">More</span>
        </button>
      </nav>
    </div>
  );
}

// ── DESKTOP ─────────────────────────────────────────────────────────────────
function DesktopShell({
  visible,
  activeId,
  email,
  role,
  signOutAction,
  deploy,
  children,
}: InnerProps & { deploy: DeployTelemetry }) {
  const online = useOnline();
  const screenLabel = activeId ? SCREEN_LABEL[activeId] : "DASHBOARD";

  return (
    <div data-chrome="scanlines" className="flex h-dvh overflow-hidden bg-base">
      {/* sidebar (chrome) */}
      <aside className="sidebar chrome">
        <Link href="/" className="block px-2 pb-2 pt-1">
          <span className="flex items-baseline gap-1.5">
            <span
              className="text-[17px] font-black tracking-wide"
              style={{ color: "var(--foreground)" }}
            >
              DEFACEMENT
            </span>
            <span
              className="font-mono text-[10px] tracking-[0.1em]"
              style={{ color: "var(--accent)" }}
            >
              SMS
            </span>
          </span>
          <span
            className="mt-[3px] block font-mono text-[9.5px] tracking-[0.14em]"
            style={{ color: "var(--zinc-600)" }}
          >
            {"// DC34 · AGENCY"}
          </span>
        </Link>

        <div className="scroll mt-1 flex-1">
          {GROUPS.map((g) => {
            const items = visible.filter((n) => n.group === g.key);
            if (!items.length) return null;
            return (
              <div key={g.key}>
                <div className="nav-group-label">{g.label}</div>
                {items.map((n) => {
                  const I = Icons[n.id];
                  return (
                    <Link
                      key={n.id}
                      href={n.href}
                      className={
                        "navitem" + (activeId === n.id ? " active" : "")
                      }
                    >
                      <I />
                      <span>{n.label}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* account */}
        <div
          className="mt-2 border-t pt-3"
          style={{ borderColor: "var(--line)" }}
        >
          <div className="flex items-center gap-2.5 px-2 pb-2.5">
            <div className="acct-avatar">{initials(email)}</div>
            <div className="min-w-0 flex-1">
              <div className="acct-email">{email}</div>
              <div className="mt-[3px]">
                <span className="rolechip">{role}</span>
              </div>
            </div>
          </div>
          <form action={signOutAction}>
            <SignOutButton className="navitem">
              <Icons.signout />
              <span>Sign out</span>
            </SignOutButton>
          </form>
        </div>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* top strip (chrome) */}
        <div className="topstrip chrome">
          <span className="prompt">{screenLabel}</span>
          <div className="sep" />
          <span className="statlight">
            <span style={{ color: "var(--zinc-500)" }}>DEPLOY</span>{" "}
            <b style={{ color: "var(--accent)" }}>
              {pad3(deploy.deployed)}/{pad3(deploy.total)}
            </b>{" "}
            <span style={{ color: "var(--zinc-500)" }}>· {deploy.pct}%</span>
          </span>
          <div className="sep" />
          <span className="statlight">
            <span className={"dot " + (online ? "ok" : "warn")} />
            LINK · {online ? "ONLINE" : "OFFLINE"}
          </span>
          <div className="ml-auto flex items-center gap-4">
            <span className="statlight">
              <VegasClock />
            </span>
          </div>
        </div>

        {/* active screen */}
        <div className="scroll min-h-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-5 py-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
