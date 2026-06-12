-- Trigram GIN indexes backing the signs list free-text search, which runs a
-- triple ILIKE '%term%' over sign_text / item_id / placement_area on every
-- keystroke past the debounce (app/(app)/signs/_lib.ts → buildSignWhere).
-- A leading-wildcard ILIKE can't use a btree; gin_trgm_ops makes it an index
-- scan instead of a per-search seq scan. pg_trgm ships with Postgres contrib
-- and is available on managed Postgres.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "signs_sign_text_trgm_idx" ON "signs" USING GIN ("sign_text" gin_trgm_ops);
CREATE INDEX "signs_item_id_trgm_idx" ON "signs" USING GIN ("item_id" gin_trgm_ops);
CREATE INDEX "signs_placement_area_trgm_idx" ON "signs" USING GIN ("placement_area" gin_trgm_ops);
