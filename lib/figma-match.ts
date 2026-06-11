// Pure logic for mapping rendered Figma nodes back to the signs they depict.
//
// Contract (pinned in the figma-mcp-signs skill): each rendered sign node's name
// STARTS WITH the sign's Item ID — e.g. "M-001 - DEF CON REGISTRATION". That makes
// the node↔sign mapping deterministic and app-known, instead of relying on a
// render-time sequence number the app never sees. No network/DB here, so it's
// fully unit-testable; the REST calls live in lib/figma-api.ts.

export type FigmaNodeLite = { id: string; name: string };

// A Figma document node is a tree; only `children` matters for our walk.
type FigmaTreeNode = {
  id?: unknown;
  name?: unknown;
  children?: unknown;
};

export type SignLite = { id: number; itemId: string };

export type PreviewMatch = {
  signId: number;
  itemId: string;
  nodeId: string;
  nodeName: string;
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
      out.push({ id: node.id, name: node.name });
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

// Map nodes → signs by Item-ID prefix. Each sign takes the FIRST node that
// identifies it; each node is consumed at most once (so two signs can't claim the
// same node). Returns the matches plus the signs and nodes left over, so the
// caller can report coverage ("imported N, M signs unmatched").
export function matchNodesToSigns(
  nodes: FigmaNodeLite[],
  signs: SignLite[],
): MatchResult {
  const matched: PreviewMatch[] = [];
  const unmatchedSigns: SignLite[] = [];
  const consumed = new Set<string>();

  for (const sign of signs) {
    const node = nodes.find(
      (n) => !consumed.has(n.id) && nameMatchesItemId(n.name, sign.itemId),
    );
    if (node) {
      consumed.add(node.id);
      matched.push({
        signId: sign.id,
        itemId: sign.itemId,
        nodeId: node.id,
        nodeName: node.name,
      });
    } else {
      unmatchedSigns.push(sign);
    }
  }

  const unmatchedNodes = nodes.filter((n) => !consumed.has(n.id));
  return { matched, unmatchedSigns, unmatchedNodes };
}
