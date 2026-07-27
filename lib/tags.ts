// System tags: slugs the app manages internally and hides from the user-facing tag
// UI (filter chips + the sign form's tag editor). They exist to drive behavior, not
// to be curated by a lead, so the tag editor never shows them and the wholesale
// tag-replace on sign edit preserves them (see app/(app)/signs/actions.ts). Keeping
// them out of the editor is what makes them safe to rely on as a scoping mechanism.
//
// `master-sheet` marks a sign as sourced from Nikita's master Google Sheet. The
// reconcile flow (M18) only ever considers signs carrying it, so hand-added
// wayfinding and the all-venue standing signs stay invisible to reconcile. It must
// stay non-user-editable: clearing it would silently drop a sign out of reconcile.
export const MASTER_SHEET_TAG = "master-sheet";

// The full set of system-managed tag slugs. Extend here if more are added.
export const SYSTEM_TAG_SLUGS: ReadonlySet<string> = new Set([MASTER_SHEET_TAG]);

// Array form for Prisma `notIn` filters (hide system tags from user-facing lists).
export const SYSTEM_TAG_SLUG_LIST: string[] = [...SYSTEM_TAG_SLUGS];

export function isSystemTag(slug: string): boolean {
  return SYSTEM_TAG_SLUGS.has(slug);
}
