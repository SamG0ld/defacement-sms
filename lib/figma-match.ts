// Pure logic for mapping rendered Figma nodes back to the signs they depict.
//
// Contract (pinned in the figma-mcp-signs skill): each rendered sign node's name is
// "<Item ID> - <UPPERCASE SIGN TEXT>" — e.g. "M-001 - DEF CON REGISTRATION". Item ID
// alone is NOT unique (schema: `@@index([itemId])`, no unique), so the same Item ID
// can appear on several sign rows in one batch (a booth with a single- and a
// double-face board, duplicate room codes, etc.). Matching on the Item-ID prefix
// alone is therefore ambiguous for those rows. So we match in two passes: first on
// the FULL name (Item ID + uppercased sign text) which disambiguates duplicates,
// then fall back to the Item-ID prefix for anything the full-name pass didn't place
// (a singleton whose rendered text drifted from the stored `signText`). That fallback
// is ENFORCED to the singleton case: if two signs sharing an Item ID both reach it,
// neither is matched — guessing by document order would silently put one sign's art
// on another. No network/DB here, so it's fully unit-testable; the REST calls live in
// lib/figma-api.ts.

export type FigmaNodeLite = {
  id: string;
  name: string;
  // The Figma node type ("INSTANCE" | "FRAME" | "COMPONENT" | "TEXT" | …) when the tree
  // carries it. Optional: matching never depends on it — the per-size reconcile uses it only
  // to tell a rendered sign INSTANCE apart from a container / template / text layer.
  type?: string;
  // Canvas-space size (from the node's absoluteBoundingBox) when the file JSON carries
  // it — lets the caller render previews at a reduced, area-bounded scale rather than
  // full print resolution. Optional: matching never depends on it.
  width?: number;
  height?: number;
};

// A Figma document node is a tree; only `children` matters for our walk.
type FigmaTreeNode = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  children?: unknown;
  absoluteBoundingBox?: unknown;
};

// `signText` is optional so callers that only know the Item ID still work (the
// prefix-only fallback). When present it enables the exact full-name match that
// disambiguates duplicate Item IDs. `figmaInstanceNodeId` (the node this sign was last
// rendered to, captured on preview import) lets the per-size reconcile recognize a text
// edit: a sign whose stored node still sits in the file under a drifted name is a
// CORRECTION (retext in place), not a fresh append.
export type SignLite = {
  id: number;
  itemId: string;
  signText?: string;
  figmaInstanceNodeId?: string | null;
};

export type PreviewMatch = {
  signId: number;
  itemId: string;
  nodeId: string;
  nodeName: string;
  // Node canvas size (when known), carried through so the caller can render previews
  // at a reduced, area-bounded scale instead of full print resolution.
  width?: number;
  height?: number;
};

export type MatchResult = {
  matched: PreviewMatch[];
  unmatchedSigns: SignLite[];
  unmatchedNodes: FigmaNodeLite[];
};

// Flatten a Figma document tree (from GET /v1/files/:key → .document) into a flat
// list of {id, name}. Defensive about shape — the API response is untyped JSON.
export function flattenFigmaNodes(root: unknown): FigmaNodeLite[] {
  const out: FigmaNodeLite[] = [];
  const visit = (node: FigmaTreeNode | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "string" && typeof node.name === "string") {
      const box =
        node.absoluteBoundingBox && typeof node.absoluteBoundingBox === "object"
          ? (node.absoluteBoundingBox as { width?: unknown; height?: unknown })
          : null;
      out.push({
        id: node.id,
        name: node.name,
        ...(typeof node.type === "string" ? { type: node.type } : {}),
        ...(typeof box?.width === "number" ? { width: box.width } : {}),
        ...(typeof box?.height === "number" ? { height: box.height } : {}),
      });
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child as FigmaTreeNode);
    }
  };
  visit(root as FigmaTreeNode);
  return out;
}

// True when a node name identifies this Item ID: an exact match, or the Item ID
// followed by a space (the "M-001 - NAME" convention). The trailing-space boundary
// stops "M-1" from matching "M-10 - …".
function nameMatchesItemId(nodeName: string, itemId: string): boolean {
  const name = nodeName.trim();
  // Trim the Item ID too — a stray trailing space from a CSV import quirk must not
  // silently break every match for that sign. (Item IDs never contain an embedded
  // space, so the trailing-space prefix boundary stays sound.)
  const id = itemId.trim();
  return name === id || name.startsWith(id + " ");
}

// The full node name the generator writes for a sign: "<Item ID> - <UPPERCASE TEXT>",
// where TEXT is the trimmed+uppercased sign text (same strip+upper the batch loop
// applies). Used for the exact first-pass match that disambiguates duplicate Item IDs.
// Exported so the per-size reconcile manifest (lib/figma-reconcile.ts) keys sign-side
// collisions off the SAME identity string this matcher uses — the two can't drift.
export function expectedNodeName(itemId: string, signText: string): string {
  return `${itemId.trim()} - ${signText.trim().toUpperCase()}`;
}

// A back-face node in the double-sided print convention: `<Item ID>-BACK - <BACK TEXT>` (the
// Item-ID part ends with `-BACK`). The back face is a pure print artifact — the app stores one
// front preview + `backText` per sign, NOT a second sign row, so a back node is deliberately
// matched to nothing. The per-size reconcile uses this to keep back faces out of the stale-orphan
// list (they'd otherwise look like unclaimed rendered instances). Lives here, beside the other
// node-identity helpers, so the naming convention has one home.
export function isBackFaceNodeName(nodeName: string): boolean {
  return nodeName.trim().split(" - ")[0].trim().endsWith("-BACK");
}

// Map nodes → signs. Two passes, each consuming a node at most once (so two signs
// can never claim the same node):
//   1. exact full-name match ("<Item ID> - <UPPERCASE signText>") — disambiguates
//      duplicate Item IDs, whose prefix alone is ambiguous;
//   2. Item-ID-prefix fallback for signs the first pass didn't place (no signText,
//      or rendered text drifted from the stored value) — only when that Item ID has
//      exactly ONE sign still pending; an ambiguous group is left unmatched rather
//      than guessed at.
// Returns the matches plus the signs and nodes left over, so the caller can report
// coverage ("imported N, M signs unmatched") — an ambiguous group lands in
// unmatchedSigns, so it shows up in that count instead of passing as a clean import.
export function matchNodesToSigns(
  nodes: FigmaNodeLite[],
  signs: SignLite[],
): MatchResult {
  const matched: PreviewMatch[] = [];
  const consumed = new Set<string>();

  const claim = (sign: SignLite, node: FigmaNodeLite): void => {
    consumed.add(node.id);
    matched.push({
      signId: sign.id,
      itemId: sign.itemId,
      nodeId: node.id,
      nodeName: node.name,
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
    });
  };

  // Pass 1 — exact full-name match (only for signs whose text we know).
  const pending: SignLite[] = [];
  for (const sign of signs) {
    if (!sign.signText) {
      pending.push(sign);
      continue;
    }
    const expected = expectedNodeName(sign.itemId, sign.signText);
    const node = nodes.find(
      (n) => !consumed.has(n.id) && n.name.trim() === expected,
    );
    if (node) claim(sign, node);
    else pending.push(sign);
  }

  // Pass 2 — Item-ID-prefix fallback for anything the exact pass didn't place.
  // The prefix alone cannot tell two signs sharing an Item ID apart, so the fallback
  // is only sound when exactly ONE sign is still pending for that Item ID — the
  // documented "singleton whose rendered text drifted" case. With two or more
  // pending, claiming by document order would attach one sign's art to another and
  // report it as a clean import; the whole group goes to unmatchedSigns instead, for
  // a human to resolve. Same stance lib/figma-reconcile.ts takes with ManifestAmbiguous.
  const pendingPerItemId = new Map<string, number>();
  for (const sign of pending) {
    const id = sign.itemId.trim();
    pendingPerItemId.set(id, (pendingPerItemId.get(id) ?? 0) + 1);
  }

  const unmatchedSigns: SignLite[] = [];
  for (const sign of pending) {
    const ambiguous = (pendingPerItemId.get(sign.itemId.trim()) ?? 0) > 1;
    const node = ambiguous
      ? undefined
      : nodes.find(
          (n) => !consumed.has(n.id) && nameMatchesItemId(n.name, sign.itemId),
        );
    if (node) claim(sign, node);
    else unmatchedSigns.push(sign);
  }

  const unmatchedNodes = nodes.filter((n) => !consumed.has(n.id));
  return { matched, unmatchedSigns, unmatchedNodes };
}
