import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

import { addUser, setUserRole } from "./actions";
import { UserRowActions } from "./_components/UserRowActions";

const ROLES = ["admin", "lead", "volunteer"] as const;

type UsersPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function UsersPage({ searchParams }: UsersPageProps) {
  const session = await getSession();
  // The (app) layout already guarantees authenticated + active; this is the
  // admin-only gate for user management.
  if (session?.user?.role !== "admin") {
    redirect("/");
  }
  const { error } = await searchParams;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-zinc-400">
          Approve teammates and manage access. Anyone added here can sign in with
          Google; deactivating revokes access.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <form
        action={addUser}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Email
          <input
            type="email"
            name="email"
            required
            placeholder="teammate@example.com"
            className="w-72 rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Role
          <select
            name="role"
            defaultValue="volunteer"
            className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            name="welcome"
            defaultChecked
            className="h-4 w-4 rounded border-zinc-700 bg-black"
          />
          Send welcome email
        </label>
        <button
          type="submit"
          className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
        >
          Add user
        </button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Last login</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {users.map((u) => {
              const isSelf = u.id === session.user.id;
              return (
                <tr key={u.id} className="text-zinc-200">
                  <td className="px-3 py-2">
                    {u.email}
                    {u.name ? (
                      <span className="ml-2 text-xs text-zinc-500">{u.name}</span>
                    ) : null}
                    {isSelf ? (
                      <span className="ml-2 text-xs text-zinc-600">(you)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {isSelf ? (
                      <span className="text-xs uppercase">{u.role}</span>
                    ) : (
                      <form
                        action={setUserRole.bind(null, u.id)}
                        className="flex items-center gap-1"
                      >
                        <select
                          name="role"
                          defaultValue={u.role}
                          className="rounded border border-zinc-700 bg-black px-1.5 py-1 text-xs text-zinc-100"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Save
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={u.isActive ? "text-emerald-400" : "text-zinc-500"}
                    >
                      {u.isActive ? "● active" : "○ inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {u.lastLoginAt
                      ? u.lastLoginAt.toISOString().slice(0, 10)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!isSelf && (
                      <UserRowActions userId={u.id} isActive={u.isActive} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
