# Manual browser harnesses

Playwright scripts that check things the automated suites structurally cannot:
hydration correctness, the **offline → queue → reconnect → drain** cycle that the
field tool is built on, and interaction bugs that only exist once React is actually
scheduling renders in a browser. They are run by hand, not by CI (see *Why not CI*
below).

They exist because the failures they catch are silent. Issue #150 (React #418 on
every page load) sat open for weeks partly because a prod build's minified stack
can't name the component, and because the offline half of the bug only appears on
a device that is *already* offline when the page loads.

Issue #149 is the sharper lesson: a green unit test is what let a *non-fix* ship to
prod. The bulk toolbar's dismissal was "fixed" by PR #141 and verified by a
pure-state test that still passes today — the actual defect lived in React
discarding a render-phase state update, which no Node-env test can observe. If a
bug only reproduces with a real browser driving real renders, the guard belongs
here, not in a unit test that will go green without touching the failure.

## Running them

Each needs a dev server and this worktree's own local Postgres — never a shared
or deployed database. Every script seeds the rows it needs and deletes them afterwards.

```bash
npx next dev -p 3037                        # in this worktree
node tests/manual/hydration-check.mjs       # React #418 across the main routes
node tests/manual/signs-offline-cycle.mjs   # /signs status queue, full cycle
node tests/manual/deploy-offline-cycle.mjs  # /deploy field PWA, full cycle
node tests/manual/bulkbar-clear-check.mjs   # /signs bulk toolbar dismisses on clear
```

Override the port with `MANUAL_TEST_PORT`. Each script exits non-zero if any
check fails and prints a PASS/FAIL line per check.

| script | what it proves |
| --- | --- |
| `hydration-check.mjs` | No hydration mismatch on `/login`, `/`, `/signs`, `/signs/new`, `/deploy` — **including with `navigator.onLine === false` at page load**, the case that regressed in #150 |
| `signs-offline-cycle.mjs` | A status change made offline is durable in IndexedDB, never reaches the server early, drains on reconnect, and clears its markers |
| `deploy-offline-cycle.mjs` | Same for a crew claim on `/deploy`, plus: a failed sync reports Offline even while `navigator.onLine` is `true` (captive portal), and recovers |
| `bulkbar-clear-check.mjs` | The `/signs` bulk toolbar actually dismisses when you hit **clear** — the #149 guard. Watches `.bulkbar` mount/unmount and every `data-exiting` flip, so it distinguishes "the exit never started" from "the exit started and got cancelled" (which is what was really happening) |

## Session minting

The interesting pages are auth-gated, so each script mints a NextAuth v5 JWT with
`encode()` from `next-auth/jwt` using the **local** `AUTH_SECRET` and sets it as a
cookie. This only ever works against `localhost` with a dev secret — it is a test
fixture, not an auth bypass, and the closed-registration `signIn` callback is
untouched by it. Nothing here should ever be pointed at a deployed environment.

## Why not CI

CI's Playwright job is deliberately **unauthenticated** (`tests/e2e/smoke.spec.ts`
— the app boots and the auth gate behaves, no OAuth). Promoting these would mean
standing up a seeded authed session plus fixture data in the CI database, which is
its own piece of work — tracked in Tech Debt rather than bolted onto the PR that
introduced these. Until then: run them by hand when touching hydration, the sync
providers (`app/(app)/signs/_sync/`, `app/(app)/deploy/_lib/store.ts`), or
anything that renders off connectivity.
