-- Pre-populate admin(s) so login is possible under closed registration.
-- REPLACE the placeholder email(s) below with your own before running — or, simpler,
-- use the BOOTSTRAP_ADMIN_EMAILS env var, which auto-provisions the first admin on
-- first Google sign-in (see README → First login / DEPLOY.md).
-- Idempotent: re-running re-asserts admin + active without creating duplicates.
-- Notes: id is TEXT/cuid (gen_random_uuid()::text), role is the "UserRole" enum, and
-- updatedAt has no DB default so we set it explicitly.
INSERT INTO "users" (
  "id", "email", "role", "isActive", "tokenVersion", "profileCompleted", "createdAt", "updatedAt"
) VALUES
  (gen_random_uuid()::text, 'admin@example.com', 'admin'::"UserRole", true, 0, false, NOW(), NOW())
  -- add more admin rows here as needed
ON CONFLICT ("email") DO UPDATE
  SET "role" = 'admin'::"UserRole",
      "isActive" = true,
      "updatedAt" = NOW();
