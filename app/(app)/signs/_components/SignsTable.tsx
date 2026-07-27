import { SelectAllHeader } from "../_selection";
import { CollapsibleTableGroup } from "./CollapsibleTableGroup";
import { SignRowTr } from "./SignRowTr";
import type { SignGroup } from "./grouping";

// Desktop signs table (SignsView mounts it on desktop; SignCards on mobile).
// Console treatment (.datatable): mono item IDs, accent hover rail. Identical signs
// collapse under one expandable header (CollapsibleTableGroup); unique signs render
// as a normal row. Each group is its own <tbody>. Rows keep the real selection /
// status / hardware islands; each header carries a tooltip.
export function SignsTable({ groups }: { groups: SignGroup[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="datatable">
          <thead>
            <tr>
              <th
                className="w-8"
                title="Select rows for a bulk action"
                style={{ paddingRight: 0 }}
              >
                <SelectAllHeader />
              </th>
              <th title="Item ID — the sign's stable identifier; click it to open the detail page">
                Item
              </th>
              <th title="The sign's display text. Identical signs collapse under one ×N header">
                Sign
              </th>
              <th title="Sign type — e.g. Directional, Informational, Banner, Poster">
                Type
              </th>
              <th title="Placement zone (Level / Hall); off-site buildings keep their prefix">
                Zone
              </th>
              <th title="Deployment slot — con day + AM/PM for time-rotated signs">
                Slot
              </th>
              <th title="Tags — villages, tracks, and other groupings">Tags</th>
              <th title="Workflow stage — click a status, then Confirm, to change it">
                Status
              </th>
              <th title="Hardware — for easel / meterboard signs, whether the gear has been collected; click to toggle">
                HW
              </th>
            </tr>
          </thead>
          {groups.map((g) =>
            g.total === 1 ? (
              <tbody key={g.key}>
                <SignRowTr sign={g.rows[0]} />
              </tbody>
            ) : (
              <CollapsibleTableGroup
                key={g.key}
                rep={g.rows[0]}
                total={g.total}
                taken={g.taken}
              >
                {g.rows.map((sign) => (
                  <SignRowTr key={sign.id} sign={sign} nested />
                ))}
              </CollapsibleTableGroup>
            ),
          )}
        </table>
      </div>
    </div>
  );
}
