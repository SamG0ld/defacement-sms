import { describe, expect, it } from "vitest";

import { buildFigmaManifest, type RemovedSign } from "@/lib/figma-reconcile";
import type { FigmaNodeLite, SignLite } from "@/lib/figma-match";

// A file node named the way the generator writes it: "<Item ID> - <UPPER TEXT>". Rendered
// signs are component INSTANCES — the type the orphan filter keys on.
function node(id: string, itemId: string, text: string): FigmaNodeLite {
  return { id, name: `${itemId} - ${text.toUpperCase()}`, type: "INSTANCE" };
}
function sign(
  id: number,
  itemId: string,
  signText: string,
  figmaInstanceNodeId?: string,
): SignLite {
  return {
    id,
    itemId,
    signText,
    ...(figmaInstanceNodeId ? { figmaInstanceNodeId } : {}),
  };
}
function removed(
  id: number,
  itemId: string,
  signText: string,
  figmaInstanceNodeId?: string,
): RemovedSign {
  return { id, itemId, signText, figmaInstanceNodeId };
}

const NONE: RemovedSign[] = [];

describe("buildFigmaManifest", () => {
  it("matches an active sign to its node (in file, no work)", () => {
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Aerospace Village")],
      activeSigns: [sign(1, "W100", "Aerospace Village")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({
      inFile: 1,
      appends: 0,
      deletes: 0,
      ambiguous: 0,
    });
    expect(m.inFile[0]).toMatchObject({ signId: 1, nodeId: "n1" });
  });

  it("flags a REMOVED sign's node as a DELETE (the real DC34 TRAINING case)", () => {
    // A training sign was removed from the record; its instance still sits in the file.
    const m = buildFigmaManifest({
      nodes: [
        node("n1", "T-01", "Training 01"),
        node("n2", "W100", "Aerospace Village"),
      ],
      activeSigns: [sign(1, "W100", "Aerospace Village")],
      removedSigns: [removed(2, "T-01", "Training 01")],
    });
    expect(m.counts).toMatchObject({ inFile: 1, deletes: 1, appends: 0, ambiguous: 0 });
    expect(m.deletes[0]).toMatchObject({ nodeId: "n1", signId: 2 });
  });

  it("matches a removed sign by its stored instance node id even if the text drifted", () => {
    const m = buildFigmaManifest({
      nodes: [{ id: "1:5", name: "renamed by hand" }],
      activeSigns: [],
      removedSigns: [removed(9, "T-02", "Training 02", "1:5")],
    });
    expect(m.counts.deletes).toBe(1);
    expect(m.deletes[0]).toMatchObject({ nodeId: "1:5", signId: 9 });
  });

  it("NEVER deletes a container / template node the record has no removed sign for", () => {
    // The document root, a page, and a template node — none map to a removed sign.
    const m = buildFigmaManifest({
      nodes: [
        { id: "0:0", name: "Document" },
        { id: "0:1", name: "Page 1" },
        { id: "2:0", name: "22x28 TEMPLATE" },
        node("n1", "W100", "Aerospace Village"),
      ],
      activeSigns: [sign(1, "W100", "Aerospace Village")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 1, deletes: 0, appends: 0, ambiguous: 0 });
  });

  it("flags an active sign with no node as an APPEND (not yet rendered)", () => {
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Aerospace Village")],
      activeSigns: [
        sign(1, "W100", "Aerospace Village"),
        sign(2, "W200", "Car Hacking Village"),
      ],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 1, appends: 1, deletes: 0, ambiguous: 0 });
    expect(m.appends[0]).toMatchObject({ signId: 2, itemId: "W200" });
  });

  it("duplicate Item ID with distinct text stays unambiguous (both match by full name)", () => {
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Front Desk"), node("n2", "W100", "Back Desk")],
      activeSigns: [sign(1, "W100", "Front Desk"), sign(2, "W100", "Back Desk")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 2, appends: 0, deletes: 0, ambiguous: 0 });
  });

  it("two active signs with identical Item ID AND text → AMBIGUOUS, never a false append", () => {
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Village")],
      activeSigns: [sign(1, "W100", "Village"), sign(2, "W100", "Village")],
      removedSigns: NONE,
    });
    expect(m.counts.ambiguous).toBe(1);
    expect(m.counts.appends).toBe(0);
    expect(m.counts.deletes).toBe(0);
    const amb = m.ambiguous[0];
    expect(amb.kind).toBe("sign");
    if (amb.kind === "sign") expect(amb.signIds.sort()).toEqual([1, 2]);
  });

  it("one node mapping to two removed signs → AMBIGUOUS, never a blind delete", () => {
    const m = buildFigmaManifest({
      nodes: [node("n1", "T-01", "Training")],
      activeSigns: [],
      removedSigns: [
        removed(1, "T-01", "Training"),
        removed(2, "T-01", "Training"),
      ],
    });
    expect(m.counts.deletes).toBe(0);
    expect(m.counts.ambiguous).toBe(1);
    const amb = m.ambiguous[0];
    expect(amb.kind).toBe("node");
    if (amb.kind === "node") expect(amb.signIds.sort()).toEqual([1, 2]);
  });

  it("regression: a node whose name collides with ambiguous active signs is NOT silently dropped or deleted", () => {
    // Two active signs share a name, one matching node, AND a removed sign maps to it too.
    // The old greedy matcher consumed the node and lost it entirely. Now the collision is
    // flagged (kind sign) and the node is never blind-deleted.
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Village")],
      activeSigns: [sign(1, "W100", "Village"), sign(2, "W100", "Village")],
      removedSigns: [removed(3, "W100", "Village")],
    });
    expect(m.counts.deletes).toBe(0); // never delete a maybe-live node
    expect(m.counts.appends).toBe(0);
    expect(m.ambiguous.some((a) => a.kind === "sign")).toBe(true);
  });

  it("regression: a blank-text active sign cannot steal a removed sign's node (delete is preserved)", () => {
    // Reused Item ID: an active sign at W100 with no text, and a removed sign whose old
    // instance "W100 - OLD REMOVED EXHIBITOR" is still in the file. Exact-identity matching
    // means the blank sign can't prefix-claim that node — the delete is reported.
    const m = buildFigmaManifest({
      nodes: [node("n1", "W100", "Old Removed Exhibitor")],
      activeSigns: [sign(1, "W100", "")],
      removedSigns: [removed(99, "W100", "Old Removed Exhibitor")],
    });
    expect(m.counts.inFile).toBe(0);
    expect(m.counts.deletes).toBe(1);
    expect(m.deletes[0]).toMatchObject({ nodeId: "n1", signId: 99 });
    expect(m.counts.appends).toBe(1); // the blank active sign → needs render
    expect(m.appends[0].signId).toBe(1);
  });

  it("empty file: every active sign is an append; nothing to delete", () => {
    const m = buildFigmaManifest({
      nodes: [],
      activeSigns: [sign(1, "W100", "A"), sign(2, "W200", "B")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 0, appends: 2, deletes: 0, ambiguous: 0 });
  });

  it("surfaces an unmatched rendered INSTANCE as a STALE orphan (the VETCON leftover), never a silent drop", () => {
    // W326's text was edited in the app; the old-text node still sits in the file, matching no
    // active sign and tied to no removed sign. It must surface as stale, not be ignored.
    const m = buildFigmaManifest({
      nodes: [
        node("n1", "W100", "Aerospace Village"),
        node("stale", "W326", "Vetcon 2025 Party"),
      ],
      activeSigns: [sign(1, "W100", "Aerospace Village")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 1, appends: 0, deletes: 0, orphans: 1 });
    expect(m.orphans[0]).toMatchObject({
      nodeId: "stale",
      nodeName: "W326 - VETCON 2025 PARTY",
    });
  });

  it("does NOT flag containers, text layers, or -BACK faces as orphans", () => {
    const m = buildFigmaManifest({
      nodes: [
        node("n1", "W100", "Aerospace Village"), // matched instance
        { id: "tpl", name: "Template BG - Meterboard 4x8", type: "FRAME" }, // template frame
        { id: "txt", name: "Sign Text", type: "TEXT" }, // a text layer
        { id: "back", name: "W100-BACK - SEE OTHER SIDE", type: "INSTANCE" }, // intentional back face
      ],
      activeSigns: [sign(1, "W100", "Aerospace Village")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 1, orphans: 0 });
  });

  it("recognizes an edited sign's drifted node as a CORRECTION (retext in place), not an append+orphan", () => {
    // The sign was rendered (figmaInstanceNodeId '1:9'); its text was then edited. The stored
    // node still sits in the file under the OLD name → retext it, don't append a duplicate.
    const m = buildFigmaManifest({
      nodes: [{ id: "1:9", name: "W326 - VETCON 2025 PARTY", type: "INSTANCE" }],
      activeSigns: [sign(1, "W326", "VETCON 2026 Party", "1:9")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ inFile: 0, appends: 0, orphans: 0, corrections: 1 });
    expect(m.corrections[0]).toMatchObject({
      nodeId: "1:9",
      fromName: "W326 - VETCON 2025 PARTY",
      toName: "W326 - VETCON 2026 PARTY",
      signId: 1,
    });
  });

  it("correction falls back to append + orphan when the stored node isn't this file's node", () => {
    // Stored id points nowhere in this file → the sign is a normal append; the unrelated
    // unmatched instance is a stale orphan.
    const m = buildFigmaManifest({
      nodes: [node("other", "W900", "Some Old Sign")],
      activeSigns: [sign(1, "W326", "VETCON 2026 Party", "does-not-exist")],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ corrections: 0, appends: 1, orphans: 1 });
    expect(m.appends[0]).toMatchObject({ signId: 1, itemId: "W326" });
    expect(m.orphans[0]).toMatchObject({ nodeId: "other" });
  });

  it("two active signs sharing ONE stored node id → AMBIGUOUS node, never a correction + stray append", () => {
    // figmaInstanceNodeId has no unique constraint. Two unmatched active signs both pointing at
    // node 1:9 can't both be retexted — surface ambiguous, never silently correct one and append
    // the other (which would reintroduce the duplicate this feature catches).
    const m = buildFigmaManifest({
      nodes: [{ id: "1:9", name: "W326 - OLD NAME", type: "INSTANCE" }],
      activeSigns: [
        sign(1, "W326", "New Name A", "1:9"),
        sign(2, "W326", "New Name B", "1:9"),
      ],
      removedSigns: NONE,
    });
    expect(m.counts).toMatchObject({ corrections: 0, appends: 0, orphans: 0, ambiguous: 1 });
    const amb = m.ambiguous[0];
    expect(amb.kind).toBe("node");
    if (amb.kind === "node") {
      expect(amb.nodeId).toBe("1:9");
      expect(amb.signIds.sort()).toEqual([1, 2]);
    }
  });
});
