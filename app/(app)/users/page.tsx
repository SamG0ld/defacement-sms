import { requirePageRole } from "@/lib/page-guards";
import { prisma } from "@/lib/db";

import { addUser, setUserRole } from "./actions";
import { UserRowActions } from "./_components/UserRowActions";

const ROLES = ["admin", "lead", "volunteer"] as const;

type UsersPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function UsersPage({ searchParams }: UsersPageProps) {
  // Admin-only gate for user management (defense in depth on top of the (app)
  // layout's authn redirect). Returns the session for the self-row check below.
  const session = await requirePageRole("admin");
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
    <div className="space-y-5">
      <div>
        <span className="prompt">USERS</span>
        <h1 className="mt-1.5 text-[24px] font-extrabold tracking-tight">Crew</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Approve teammates and manage access. Anyone added here can sign in with
          Google or a one-time email link — using the exact address below.
          Deactivating revokes access.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <form
        action={addUser}
        className="panel flex flex-wrap items-end gap-3 p-4"
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Email
          <input
            type="email"
            name="email"
            required
            placeholder="teammate@example.com"
            className="field w-72"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Role
          <select name="role" defaultValue="volunteer" className="field">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            name="welcome"
            defaultChecked
            className="h-4 w-4 rounded border-zinc-700 bg-black"
          />
          Send welcome email
        </label>
        <button type="submit" className="btn btn-primary">
          Add user
        </button>
      </form>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="datatable">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === session.user.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="t-text">{u.email}</span>
                      {u.name ? (
                        <span className="ml-2 t-dim">{u.name}</span>
                      ) : null}
                      {isSelf ? (
                        <span className="ml-2 t-dim">(you)</span>
                      ) : null}
                    </td>
                    <td>
                      {isSelf ? (
                        <span className="rolechip">{u.role}</span>
                      ) : (
                        <form
                          action={setUserRole.bind(null, u.id)}
                          className="flex items-center gap-1.5"
                        >
                          <select
                            name="role"
                            defaultValue={u.role}
                            className="field py-1 text-xs"
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="btn btn-sm">
                            Save
                          </button>
                        </form>
                      )}
                    </td>
                    <td>
                      <span className={u.isActive ? "badge badge-ok" : "badge"}>
                        {u.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="t-mono">
                      {u.lastLoginAt
                        ? u.lastLoginAt.toISOString().slice(0, 10)
                        : "—"}
                    </td>
                    <td className="text-right">
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
    </div>
  );
}
