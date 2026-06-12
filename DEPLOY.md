# Deploy runbook — Defacement SMS

Target stack: **Vercel** (Next.js) + a managed **Postgres** (e.g. Neon) + **Upstash** (Redis rate
limiting) + **Google OAuth**. Do these in order. Steps marked **(you)** are interactive and can't
be scripted.

> Credentials live only in the platform dashboards / `.env` — never commit them, never print them
> in command output. `.env.example` is the documented source of truth for variable names. Every
> `<placeholder>` below is something you fill in with your own value.

## 1. Postgres database **(you)**
1. Create a Postgres database named `defacement` (a free Neon project works well).
2. Copy two connection strings:
   - **Pooled** (has `-pooler`, `pgbouncer=true`) → `DATABASE_URL` (the app runtime).
   - **Direct** (unpooled) → `DIRECT_URL` (migrations).
   > The app caps its own pg pool at `max: 3` per instance (`lib/db.ts`), but it
   > MUST use the **pooled** endpoint here — a burst of serverless cold-starts on
   > the direct endpoint will exhaust a free-tier connection limit. Append
   > `&connection_limit=1` to a non-pooler URL only if you can't use the pooler.
3. Apply the schema against the direct URL:
   ```
   DATABASE_URL="<direct url>" npx prisma migrate deploy
   ```

## 2. Seed reference + admin data
Run against the same database (direct URL is fine):
```
npx prisma db execute --file prisma/seeds/reference-data.sql      # 11 tags + venue zones
npx prisma db execute --file prisma/seeds/equipment-types.sql     # inventory item types
npx prisma db execute --file prisma/seeds/bootstrap-admins.sql    # admin rows (idempotent)
```
Edit `bootstrap-admins.sql` to use your own admin email(s) first, or seed admins via the
`BOOTSTRAP_ADMIN_EMAILS` env var instead (step 6). Do **not** run `sample-signs.sql` in
production — that's local test data.

## 3. Upstash Redis **(you)**
1. Create a free Redis DB at <https://console.upstash.com> → **REST API** tab.
2. Note `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   These are **required in production** — `instrumentation.ts` → `assertProdEnv()` fails startup
   without them (and the rate limiter would otherwise silently no-op).
   > Vercel **preview** deployments also run with `NODE_ENV=production`, so they require these vars
   > too. Set them at the project level (all environments) or expect previews to fail startup.

## 4. Vercel project **(you)**
1. Import the GitHub repo into Vercel (framework auto-detects Next.js).
2. Set Environment Variables (Production):
   - `DATABASE_URL` (pooled), `DIRECT_URL` (direct)
   - `AUTH_SECRET` — generate: `openssl rand -base64 32`
   - `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (from step 5)
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `AUTH_RESEND_KEY`, `EMAIL_FROM` (from step 5b) — magic-link email
   - `BLOB_READ_WRITE_TOKEN` (from step 4b) — deploy-photo storage; **required in production**
   - `BOOTSTRAP_ADMIN_EMAILS` — comma-separated admin emails
   - `CSP_MODE=report` for the first deploy (flip to `enforce` in step 7)
   - `FIGMA_API_TOKEN` — *optional*; only needed for "Pull previews from Figma" on a generation
     batch. The feature reports itself as not configured when unset; nothing else depends on it.
   - `NEXTAUTH_URL` is set by Vercel automatically; override only for a custom domain.
3. Deploy.

## 4b. Vercel Blob — deploy photos **(you)**
The `/deploy` floor tool stores optional deploy photos in **Vercel Blob** (private access; served
only through the app's auth-gated route, never a public URL).
1. Vercel project → **Storage** → create a **Blob** store and connect it to this project.
2. Connecting auto-injects `BLOB_READ_WRITE_TOKEN` into the project env. Confirm it's present for
   **all environments** (preview runs as production — see step 3's note).
   > **Required in production** — `assertProdEnv()` (`lib/env.ts`) fails startup without it,
   > rather than letting the first floor photo-upload throw. Local dev works without it; photo
   > upload is simply disabled until the token is set.

## 5. Google OAuth **(you)**
Google Cloud Console → APIs & Services → Credentials → your OAuth client →
**Authorized redirect URIs**, add:
```
https://<your-vercel-domain>/api/auth/callback/google
```
(keep `http://localhost:3000/api/auth/callback/google` for local dev).
Copy the client ID/secret into the Vercel env vars (step 4) and redeploy if needed.

## 5b. Resend email — magic links **(you)**
Magic-link sign-in (for teammates who can't use Google OAuth) needs an email sender.
1. Create a Resend account at <https://resend.com>.
2. **Domains** → add a **send-subdomain** (e.g. `send.yourdomain.com`) and add the shown
   **DKIM/SPF** DNS records. Using a subdomain keeps these records off the root domain so existing
   mail is untouched. Wait for verification (green).
3. **API Keys** → create one → set `AUTH_RESEND_KEY` in Vercel (step 4).
4. Set `EMAIL_FROM` to an address on the verified (sub)domain, e.g.
   `Defacement SMS <noreply@yourdomain.com>`.
   > Both are **required in production** — `assertProdEnv()` fails startup without them. Until the
   > domain is verified, Resend only delivers to your own account email (fine for a local test).

## 6. First admin login **(you)**
1. Visit `https://<domain>/login` and sign in with a `BOOTSTRAP_ADMIN_EMAILS` Google account.
   The bootstrap promotes it to admin on first login (`lib/auth.ts`).
2. Open `/users` and add the rest of the team (closed registration — only added emails can sign in).
3. Once real admins exist, you can clear `BOOTSTRAP_ADMIN_EMAILS`.

## 7. Promote CSP to enforcing **(you)**
1. Click through the app with the browser console open; confirm no `Content-Security-Policy`
   violation reports.
2. Set `CSP_MODE=enforce` in Vercel and redeploy. The header flips from report-only to enforcing
   (`next.config.ts`).

## 8. Smoke test
- Sign in with Google; `/signs` loads; create/advance a sign; `/inventory` loads.
- Magic link: from `/login`, "Email me a sign-in link" to an **added** team email → link arrives →
  click → lands authenticated. A non-added email shows "check your inbox" but receives nothing.
- Import a CSV via `/signs/import` (preview → confirm); export via **Export CSV**.
- Security headers present (`curl -sI https://<domain>` → HSTS, X-Frame-Options, CSP).
- Bad-password storm on `/api/auth` eventually returns `429` (rate limiter live).

## Rollback
Vercel → Deployments → promote the previous good deployment. DB migrations are forward-only;
coordinate schema changes with a backup (a database branch/restore) before `migrate deploy`.

## Self-hosting (alternative to Vercel)
A multi-stage `Dockerfile` and `docker-entrypoint.sh` are included — the entrypoint runs
`prisma migrate deploy` then starts the standalone Next.js server. Build the image on a host with
the source checked out, push it to your registry, and run it behind a TLS-terminating reverse
proxy with the same environment variables as above. Set `AUTH_TRUST_HOST=""` → a truthy value when
running behind a proxy so NextAuth derives the correct callback origin.
