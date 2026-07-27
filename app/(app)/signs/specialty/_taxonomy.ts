// Intake taxonomy for externally-produced install items (union-installed
// large-format work + printed ops maps) — the specialty types offered on the
// specialty-intake form. Tags are upserted by slug at intake time, so this
// list has no seed dependency: the first intake of a given specialty type
// creates its tag, later intakes reuse it.

export type SpecialtyType = {
  key: string; // stable slug, used as the <select> value
  label: string; // human label for the form
  category: "union_installed" | "ops_map";
  tagSlug: string; // sign tag slug, upserted at intake time
  tagName: string; // display name for that tag
  defaultSize: string | null; // pre-filled size, null = leave blank for free entry
};

export const SPECIALTY_TYPES: readonly SpecialtyType[] = [
  {
    key: "floor-graphic",
    label: "Floor graphic",
    category: "union_installed",
    tagSlug: "floor-graphic",
    tagName: "Floor Graphic",
    defaultSize: null,
  },
  {
    key: "wall-graphic",
    label: "Wall graphic",
    category: "union_installed",
    tagSlug: "wall-graphic",
    tagName: "Wall Graphic",
    defaultSize: null,
  },
  {
    key: "floor-vinyl",
    label: "Floor vinyl",
    category: "union_installed",
    tagSlug: "floor-vinyl",
    tagName: "Floor Vinyl",
    defaultSize: null,
  },
  {
    key: "banner",
    label: "Banner (large-format)",
    category: "union_installed",
    tagSlug: "banner",
    tagName: "Banner",
    defaultSize: "8'x20'",
  },
  {
    key: "sticker-wall",
    label: "Sticker wall",
    category: "union_installed",
    tagSlug: "sticker-wall",
    tagName: "Sticker Wall",
    defaultSize: null,
  },
  {
    key: "selfie-banner",
    label: "Photo / selfie banner",
    category: "union_installed",
    tagSlug: "selfie-banner",
    tagName: "Selfie Banner",
    defaultSize: null,
  },
  {
    key: "venue-map",
    label: "Venue / orientation map",
    category: "ops_map",
    tagSlug: "venue-map",
    tagName: "Venue Map",
    defaultSize: "4'x8' (printed)",
  },
] as const;

// Lookup a specialty type by its key (the <select> value). Null when unknown.
export function specialtyType(key: string): SpecialtyType | null {
  return SPECIALTY_TYPES.find((t) => t.key === key) ?? null;
}
