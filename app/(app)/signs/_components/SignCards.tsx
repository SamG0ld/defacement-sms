import { CollapsibleCardGroup } from "./CollapsibleCardGroup";
import { SignCardItem } from "./SignCardItem";
import type { SignGroup } from "./grouping";

// Mobile card view of the signs list (SignsView mounts it on mobile; SignsTable on
// desktop). Console treatment (.signcard). Identical signs collapse under one
// expandable header card (CollapsibleCardGroup); unique signs render as a normal
// card. Keeps the real selection / status / hardware islands.
export function SignCards({ groups }: { groups: SignGroup[] }) {
  return (
    <div className="flex flex-col gap-[9px]">
      {groups.map((g) =>
        g.total === 1 ? (
          <SignCardItem key={g.key} sign={g.rows[0]} />
        ) : (
          <CollapsibleCardGroup
            key={g.key}
            signText={g.rows[0].signText}
            repId={g.repId}
            total={g.total}
            taken={g.taken}
          >
            {g.rows.map((sign) => (
              <SignCardItem key={sign.id} sign={sign} nested />
            ))}
          </CollapsibleCardGroup>
        ),
      )}
    </div>
  );
}
