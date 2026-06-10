import { redirect } from "next/navigation";
import Link from "next/link";

import { signOut } from "@/lib/auth";
import { hasRole } from "@/lib/rbac";
import { getSession } from "@/lib/session";
import { SignOutButton } from "@/app/_components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user?.id || !session.user.isActive) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-800 bg-zinc-950 text-zinc-100">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-sm font-semibold tracking-wide text-accent"
            >
              Defacement SMS
            </Link>
            <Link
              href="/signs"
              className="text-xs text-zinc-400 hover:text-accent"
            >
              Signs
            </Link>
            <Link
              href="/deploy"
              className="text-xs text-zinc-400 hover:text-accent"
            >
              Deploy
            </Link>
            <Link
              href="/inventory"
              className="text-xs text-zinc-400 hover:text-accent"
            >
              Inventory
            </Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            {hasRole(session.user.role, "lead") && (
              <Link href="/activity" className="hover:text-accent">
                Activity
              </Link>
            )}
            {session.user.role === "admin" && (
              <>
                <Link href="/map" className="hover:text-accent">
                  Maps
                </Link>
                <Link href="/users" className="hover:text-accent">
                  Users
                </Link>
              </>
            )}
            <span>{session.user.email}</span>
            <span className="rounded bg-zinc-800 px-2 py-0.5 uppercase">
              {session.user.role}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <SignOutButton />
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
