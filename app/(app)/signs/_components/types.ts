import type { Prisma } from "@/app/generated/prisma/client";

// Single source of truth for the signs-list query `select` and the row type the
// list/cards render. The Sign row is ~60 columns (the art-pipeline/figma fields
// etc.); pulling all of them × PAGE_SIZE every load is wasted width over the database
// wire and in the RSC payload — so the list selects only what it renders.
export const signRowSelect = {
  id: true,
  itemId: true,
  signText: true,
  signType: true,
  status: true,
  quantity: true,
  deploymentSlot: true,
  needsEasel: true,
  size: true,
  category: true,
  equipmentCheckedOut: true,
  equipmentReturned: true,
  // Grouping key fields (lib/stock SignIdentity) + the QM flag, so the list can
  // collapse identical rows and show "N at QM" without a second query.
  doubleSided: true,
  printable: true,
  zoneId: true,
  qmTakenAt: true,
  zone: { select: { zoneCode: true, zoneName: true, building: true } },
  tagAssignments: {
    select: { tagId: true, tag: { select: { name: true, color: true } } },
  },
} satisfies Prisma.SignSelect;

export type SignRow = Prisma.SignGetPayload<{ select: typeof signRowSelect }>;
