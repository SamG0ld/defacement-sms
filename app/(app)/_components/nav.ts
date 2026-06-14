// Client-safe navigation model for the app shell. Plain data + types only — NO
// server imports (the type-only UserRole/IconName imports are erased), so this is
// safe in the client bundle. Role FILTERING happens on the server (in the (app)
// layout, via rbac) and only the visible subset is passed to the client shell, so
// nav items a user can't reach never ship to their browser.
import type { UserRole } from "@/app/generated/prisma/client";
import type { IconName } from "@/app/_components/Icons";

export type NavGroup = "primary" | "control" | "admin";
export type NavEntry = {
  id: IconName; // the icon key doubles as the nav id
  label: string;
  href: string;
  group: NavGroup;
  minRole: UserRole;
};

export const NAV: NavEntry[] = [
  {
    id: "signs",
    label: "Signs",
    href: "/signs",
    group: "primary",
    minRole: "volunteer",
  },
  {
    id: "deploy",
    label: "Deploy",
    href: "/deploy",
    group: "primary",
    minRole: "volunteer",
  },
  {
    id: "inventory",
    label: "Inventory",
    href: "/inventory",
    group: "primary",
    minRole: "volunteer",
  },
  {
    id: "activity",
    label: "Activity",
    href: "/activity",
    group: "control",
    minRole: "lead",
  },
  { id: "map", label: "Maps", href: "/map", group: "admin", minRole: "admin" },
  {
    id: "users",
    label: "Users",
    href: "/users",
    group: "admin",
    minRole: "admin",
  },
];

export const GROUPS: { key: NavGroup; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "control", label: "Control" },
  { key: "admin", label: "Admin" },
];

// Screen label for the desktop top-strip prompt header, keyed by nav id.
export const SCREEN_LABEL: Record<IconName, string> = {
  signs: "SIGNS",
  deploy: "DEPLOY",
  inventory: "INVENTORY",
  activity: "ACTIVITY",
  map: "MAPS",
  users: "USERS",
  // present only to satisfy the Record over IconName (not used as screen ids)
  more: "MORE",
  search: "SEARCH",
  easel: "HARDWARE",
  signout: "SIGN OUT",
  chevron: "",
};
