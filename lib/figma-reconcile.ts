// Pure reconcile logic for the per-size record engine: given the nodes in one Figma
// file, the app's ACTIVE signs for that size bucket, and the signs REMOVED from that
// bucket's record, produce a MANIFEST of what the file is missing (append), which nodes
// belong to removed signs and should go (delete), and what can't be decided safely
// (ambiguous). No network / no DB here — the server orchestration (by-size/_manifest.ts)
// fetches the file document + the signs, then calls this; the REST calls live in
// lib/figma-api.ts. The app NEVER mutates Figma — this only emits the list a follow-on
// plugin/MCP pass executes by hand.
//
// Matching is EXACT-IDENTITY, not the importer's greedy two-pass matcher: a sign owns a
// node only by the generator's exact node name ("<Item ID> - <UPPER TEXT>", expectedNodeName)
// or, for a removed sign, its stored instance node id. Exact identity is deliberate — the
// importer's Item-ID-prefix fallback (for rendering a sign whose text drifted) would let a
// blank-text or duplicate-Item-ID active sign silently CLAIM a removed sign's node, hiding
// a delete the manifest must report. Item IDs are not unique (schema: @@index([itemId])),
// so prefix matching is unsafe here; anything without a confident exact match is surfaced,
// never guessed:
//   - DELETES are anchored to REMOVED signs only. A Figma file also holds the document/page
//     containers and Neil's template/master nodes; a node the record can't tie to a removed
//     sign (by node id or exact name) is left untouched — never flagged for deletion.
//   - a blank-/drifted-text active sign that exact-matches nothing becomes an APPEND
//     (safe over-report: "render this") rather than claiming an unrelated node.
//   - same-name collisions (≥2 active signs → one node name; ≥2 removed → one node; an
//     active AND a removed claiming one name) go to AMBIGUOUS for a human.

import {
  expectedNodeName,
  isBackFaceNodeName,
  type FigmaNodeLite,
  type PreviewMatch,
  type SignLite,
} from "./figma-match";

// A sign removed from the record whose instance may still sit in the file.
export type RemovedSign = {
  id: number;
  itemId: string;
  signText: string | null;
  figmaInstanceNodeId?: string | null;
};

// A node that belongs to a removed sign — a candidate deletion. `signId` ties it back to
// the removed record row so the follow-on pass (and the reviewer) knows why.
export type ManifestDelete = {
  nodeId: string;
  nodeName: string;
  signId: number;
};

// An active sign with no node in the file yet — a candidate render/append.
export type ManifestAppend = { signId: number; itemId: string; signText: string };

// A collision the engine won't resolve automatically. `kind: "sign"` = two+ active signs
// would render to one node name (bucket-level, file-independent); `kind: "node"` = one
// file node can't be tied to a single sign (a removed-sign collision, or a name claimed by
// both an active and a removed sign). Either way a human picks; nothing is auto-applied.
export type ManifestAmbiguous =
  | { kind: "sign"; nodeName: string; signIds: number[] }
  | { kind: "node"; nodeName: string; nodeId: string; signIds: number[] };

// A file node that matches NO active sign and ties to NO removed sign — a probable stale
// leftover (e.g. a sign whose text was edited in the app, orphaning its old-text node). Kept
// separate from `deletes` (which are anchored to removed signs): an orphan is a "delete?"
// suggestion for a human, never auto-applied. Restricted to rendered sign INSTANCE nodes so
// containers / templates / text layers — and intentional `-BACK` faces — are never flagged.
export type ManifestOrphan = { nodeId: string; nodeName: string };

// An active sign whose text was edited after it was rendered: its stored figmaInstanceNodeId
// still points at a node in the file, but that node's name has drifted from the sign's current
// expected name. Fix = RETEXT that node in place, not append a second node (which would leave
// the old-text node behind as a printed duplicate). `fromName` → `toName` is the rename.
export type ManifestCorrection = {
  nodeId: string;
  fromName: string;
  toName: string;
  signId: number;
  itemId: string;
  signText: string;
};

export type FigmaManifest = {
  inFile: PreviewMatch[]; // active signs confidently matched to a node
  appends: ManifestAppend[];
  deletes: ManifestDelete[];
  ambiguous: ManifestAmbiguous[];
  corrections: ManifestCorrection[];
  orphans: ManifestOrphan[];
  counts: {
    inFile: number;
    appends: number;
    deletes: number;
    ambiguous: number;
    corrections: number;
    orphans: number;
  };
};

// Group items by a derived key, preserving first-seen order.
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function buildFigmaManifest(input: {
  nodes: FigmaNodeLite[];
  activeSigns: SignLite[];
  removedSigns: RemovedSign[];
}): FigmaManifest {
  const { nodes, activeSigns, removedSigns } = input;
  const ambiguous: ManifestAmbiguous[] = [];

  // Active signs grouped by their exact expected node name (only signs that HAVE text can
  // exact-match; a blank-text sign has no name to match on and can only ever append).
  const activeByName = groupBy(
    activeSigns.filter((s) => s.signText && s.signText.trim() !== ""),
    (s) => expectedNodeName(s.itemId, s.signText as string),
  );

  // Active-side collisions: ≥2 active signs share one expected name. Bucket-level (same
  // regardless of file), reported once here; those signs never claim a node or append.
  const collidingActiveNames = new Set<string>();
  const ambiguousActiveIds = new Set<number>();
  for (const [name, group] of activeByName) {
    if (group.length > 1) {
      collidingActiveNames.add(name);
      group.forEach((s) => ambiguousActiveIds.add(s.id));
      ambiguous.push({ kind: "sign", nodeName: name, signIds: group.map((s) => s.id) });
    }
  }

  // Removed-sign lookups: by stored instance node id (strongest) and by exact expected name.
  const removedByNodeId = groupBy(
    removedSigns.filter((r) => r.figmaInstanceNodeId),
    (r) => r.figmaInstanceNodeId as string,
  );
  const removedByName = groupBy(
    removedSigns.filter((r) => r.signText && r.signText.trim() !== ""),
    (r) => expectedNodeName(r.itemId, r.signText as string),
  );

  const inFile: PreviewMatch[] = [];
  const deletes: ManifestDelete[] = [];
  const matchedActiveIds = new Set<number>();
  // Nodes the record has no claim on (reached step 6). Post-loop these split into text-edit
  // corrections (stored-id match) and stale orphans (rendered instances matching nothing).
  const fallThrough: FigmaNodeLite[] = [];

  for (const node of nodes) {
    const nm = node.name.trim();

    // 1. Removed sign's stored instance node id — authoritative: this node WAS its render.
    const rById = removedByNodeId.get(node.id);
    if (rById) {
      if (rById.length > 1) {
        ambiguous.push({ kind: "node", nodeName: node.name, nodeId: node.id, signIds: rById.map((r) => r.id) });
      } else {
        deletes.push({ nodeId: node.id, nodeName: node.name, signId: rById[0].id });
      }
      continue;
    }

    // 2. Name belongs to an ambiguous active-sign group — already reported (kind sign).
    // Never delete it (it may be a live sign's node); leave it for the human.
    if (collidingActiveNames.has(nm)) continue;

    const aGroup = activeByName.get(nm); // length ≤ 1 here (collisions handled above)
    const aHit = aGroup ? aGroup[0] : undefined;
    const rGroup = removedByName.get(nm);

    // 3. One name claimed by BOTH an active and a removed sign — can't tell live vs stale.
    if (aHit && rGroup) {
      ambiguous.push({
        kind: "node",
        nodeName: node.name,
        nodeId: node.id,
        signIds: [aHit.id, ...rGroup.map((r) => r.id)],
      });
      matchedActiveIds.add(aHit.id); // spoken for — don't also append it
      continue;
    }

    // 4. Active sign owns it → in file, no work.
    if (aHit) {
      inFile.push({
        signId: aHit.id,
        itemId: aHit.itemId,
        nodeId: node.id,
        nodeName: node.name,
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
      });
      matchedActiveIds.add(aHit.id);
      continue;
    }

    // 5. Removed sign owns it (by exact name) → delete.
    if (rGroup) {
      if (rGroup.length > 1) {
        ambiguous.push({ kind: "node", nodeName: node.name, nodeId: node.id, signIds: rGroup.map((r) => r.id) });
      } else {
        deletes.push({ nodeId: node.id, nodeName: node.name, signId: rGroup[0].id });
      }
      continue;
    }

    // 6. Not tied to any active or removed sign. Could be a container / template / text layer
    // (ignored below), or a stale orphan, or a text-edited sign's drifted node (both surfaced
    // below from this fall-through set).
    fallThrough.push(node);
  }

  // Corrections: an active sign that matched no node BUT whose stored render node
  // (figmaInstanceNodeId) sits unclaimed in the file under a drifted name — a text edit. Retext
  // that node in place instead of appending a duplicate. Keyed on the exact stored node id
  // (never a fuzzy Item-ID prefix — see the header) and only for signs that still have text.
  //
  // figmaInstanceNodeId has NO DB unique constraint, so guard the multi-claimant case exactly
  // like the removed-by-node-id and name-collision paths above: if ≥2 unmatched active signs
  // point at ONE node, they can't all be retexted → surface AMBIGUOUS (kind node), never a
  // correction plus a silent stray append (which would reintroduce the very duplicate this
  // feature exists to catch). Only a lone claimant becomes a correction. Marking the sign(s)
  // matched keeps them out of the append list; recording the node id keeps it out of orphans.
  const fallById = new Map(fallThrough.map((n) => [n.id, n] as const));
  const correctionCandidates = groupBy(
    activeSigns.filter(
      (s) =>
        !matchedActiveIds.has(s.id) &&
        !ambiguousActiveIds.has(s.id) &&
        !!s.signText &&
        s.signText.trim() !== "" &&
        !!s.figmaInstanceNodeId &&
        fallById.has(s.figmaInstanceNodeId),
    ),
    (s) => s.figmaInstanceNodeId as string,
  );
  const corrections: ManifestCorrection[] = [];
  const claimedNodeIds = new Set<string>();
  for (const [nid, group] of correctionCandidates) {
    const node = fallById.get(nid) as FigmaNodeLite;
    claimedNodeIds.add(nid);
    if (group.length > 1) {
      ambiguous.push({
        kind: "node",
        nodeName: node.name,
        nodeId: node.id,
        signIds: group.map((s) => s.id),
      });
      group.forEach((s) => matchedActiveIds.add(s.id)); // spoken for — don't also append
      continue;
    }
    const s = group[0];
    corrections.push({
      nodeId: node.id,
      fromName: node.name,
      toName: expectedNodeName(s.itemId, s.signText as string),
      signId: s.id,
      itemId: s.itemId,
      signText: s.signText as string,
    });
    matchedActiveIds.add(s.id); // spoken for — don't also append it
  }

  // Orphans: the remaining fall-through nodes that are rendered sign INSTANCES with a
  // sign-shaped name and no correction/ambiguous claim — probable stale leftovers ("delete?").
  // The type + name-shape filter excludes the document / page, the component, Neil's template
  // frame, and the Sign Text / Room text layers; `-BACK` faces (the double-sided print
  // convention) are intentionally matcher-inert and must never be flagged (isBackFaceNodeName).
  const orphans: ManifestOrphan[] = fallThrough
    .filter((n) => !claimedNodeIds.has(n.id))
    .filter((n) => n.type === "INSTANCE" && n.name.includes(" - "))
    .filter((n) => !isBackFaceNodeName(n.name))
    .map((n) => ({ nodeId: n.id, nodeName: n.name }));

  // Appends: active signs neither collision-ambiguous nor matched to any node (a correction
  // above counts as matched, so a text edit never double-reports as an append).
  const appends: ManifestAppend[] = activeSigns
    .filter((s) => !ambiguousActiveIds.has(s.id) && !matchedActiveIds.has(s.id))
    .map((s) => ({ signId: s.id, itemId: s.itemId, signText: s.signText ?? "" }));

  return {
    inFile,
    appends,
    deletes,
    ambiguous,
    corrections,
    orphans,
    counts: {
      inFile: inFile.length,
      appends: appends.length,
      deletes: deletes.length,
      ambiguous: ambiguous.length,
      corrections: corrections.length,
      orphans: orphans.length,
    },
  };
}
