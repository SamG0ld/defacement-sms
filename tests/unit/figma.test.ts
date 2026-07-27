import { describe, it, expect } from "vitest";

import {
  figmaFileKey,
  isAllowedImageHost,
  canonicalizeFigmaUrl,
} from "@/lib/figma";
import {
  flattenFigmaNodes,
  matchNodesToSigns,
  type FigmaNodeLite,
} from "@/lib/figma-match";

describe("figmaFileKey", () => {
  it("reads the key from a /design/ URL", () => {
    expect(
      figmaFileKey("https://www.figma.com/design/AbC123/DC34-Signs?node-id=1-2"),
    ).toBe("AbC123");
  });

  it("reads the key from the older /file/ URL", () => {
    expect(figmaFileKey("https://figma.com/file/XyZ789/Title")).toBe("XyZ789");
  });

  it("reads the key from a /board/ (FigJam) URL", () => {
    expect(figmaFileKey("https://www.figma.com/board/Brd001/Map")).toBe("Brd001");
  });

  it("returns null when there is no key segment", () => {
    expect(figmaFileKey("https://www.figma.com/design/")).toBeNull();
    expect(figmaFileKey("https://www.figma.com/files/recent")).toBeNull();
  });

  it("returns null for non-figma / non-https / garbage", () => {
    expect(figmaFileKey("https://evil.com/design/AbC123/x")).toBeNull();
    expect(figmaFileKey("http://www.figma.com/design/AbC123/x")).toBeNull();
    expect(figmaFileKey("not a url")).toBeNull();
  });

  it("rejects a key with unexpected characters", () => {
    expect(figmaFileKey("https://www.figma.com/design/AbC-123/x")).toBeNull();
  });
});

describe("canonicalizeFigmaUrl", () => {
  it("drops the ?t= share token and title slug", () => {
    expect(
      canonicalizeFigmaUrl(
        "https://www.figma.com/design/PwDpc123/4x8-Double?t=jHvdoqM-0",
      ),
    ).toBe("https://www.figma.com/design/PwDpc123");
  });

  it("drops a node-id query + title slug", () => {
    expect(
      canonicalizeFigmaUrl("https://www.figma.com/design/AbC123/DC34-Signs?node-id=1-2"),
    ).toBe("https://www.figma.com/design/AbC123");
  });

  it("normalizes the host to www.figma.com", () => {
    expect(canonicalizeFigmaUrl("https://figma.com/design/AbC123/Title")).toBe(
      "https://www.figma.com/design/AbC123",
    );
  });

  it("preserves the /file/ and /board/ kinds", () => {
    expect(canonicalizeFigmaUrl("https://figma.com/file/XyZ789/Title")).toBe(
      "https://www.figma.com/file/XyZ789",
    );
    expect(canonicalizeFigmaUrl("https://www.figma.com/board/Brd001/Map?x=1")).toBe(
      "https://www.figma.com/board/Brd001",
    );
  });

  it("keeps the branch key so two branches of one file stay distinct", () => {
    expect(
      canonicalizeFigmaUrl(
        "https://www.figma.com/design/AbC123/branch/Br4nch1/Title?t=x",
      ),
    ).toBe("https://www.figma.com/design/AbC123/branch/Br4nch1");
    // Two different branches of the SAME file must NOT collapse to one string.
    expect(
      canonicalizeFigmaUrl("https://www.figma.com/design/AbC123/branch/B1/T"),
    ).not.toBe(
      canonicalizeFigmaUrl("https://www.figma.com/design/AbC123/branch/B2/T"),
    );
  });

  it("collapses two links to the same file to one canonical string", () => {
    const a = canonicalizeFigmaUrl(
      "https://www.figma.com/design/AbC123/4x8-Double?t=abc",
    );
    const b = canonicalizeFigmaUrl(
      "https://figma.com/design/AbC123/Some-Other-Slug?node-id=9-9",
    );
    expect(a).toBe(b);
  });

  it("is idempotent — canonical in, canonical out", () => {
    const once = canonicalizeFigmaUrl(
      "https://www.figma.com/design/AbC123/Title?t=abc",
    );
    expect(canonicalizeFigmaUrl(once)).toBe(once);
  });

  it("trims surrounding whitespace", () => {
    expect(
      canonicalizeFigmaUrl("  https://www.figma.com/design/AbC123/x  "),
    ).toBe("https://www.figma.com/design/AbC123");
  });

  it("returns the trimmed original for a non-figma URL (never rewrites the host)", () => {
    expect(canonicalizeFigmaUrl("https://evil.com/design/AbC123/x")).toBe(
      "https://evil.com/design/AbC123/x",
    );
    expect(canonicalizeFigmaUrl("http://www.figma.com/design/AbC123/x")).toBe(
      "http://www.figma.com/design/AbC123/x",
    );
  });

  it("returns the trimmed original when there is no usable key segment", () => {
    expect(canonicalizeFigmaUrl("https://www.figma.com/files/recent")).toBe(
      "https://www.figma.com/files/recent",
    );
    // A key with unexpected characters can't be canonicalized safely — leave as-is.
    expect(canonicalizeFigmaUrl("https://www.figma.com/design/AbC-123/x")).toBe(
      "https://www.figma.com/design/AbC-123/x",
    );
    expect(canonicalizeFigmaUrl("not a url")).toBe("not a url");
  });
});

describe("flattenFigmaNodes", () => {
  it("walks the tree into a flat id/name list", () => {
    const doc = {
      id: "0:0",
      name: "Document",
      children: [
        {
          id: "1:1",
          name: "Page 1",
          children: [
            { id: "2:1", name: "M-001 - REGISTRATION" },
            { id: "2:2", name: "M-002 - AEROSPACE" },
          ],
        },
      ],
    };
    expect(flattenFigmaNodes(doc)).toEqual([
      { id: "0:0", name: "Document" },
      { id: "1:1", name: "Page 1" },
      { id: "2:1", name: "M-001 - REGISTRATION" },
      { id: "2:2", name: "M-002 - AEROSPACE" },
    ]);
  });

  it("is defensive about non-object / missing shapes", () => {
    expect(flattenFigmaNodes(null)).toEqual([]);
    expect(flattenFigmaNodes({ children: "nope" })).toEqual([]);
    expect(flattenFigmaNodes({ id: 5, name: "no string id" })).toEqual([]);
  });

  it("captures node width/height from absoluteBoundingBox (used for preview scaling)", () => {
    const doc = {
      id: "0:0",
      name: "Doc",
      children: [
        { id: "1:1", name: "no box" },
        {
          id: "2:1",
          name: "M-001 - SIGN",
          absoluteBoundingBox: { x: 0, y: 0, width: 2731, height: 4096 },
        },
      ],
    };
    expect(flattenFigmaNodes(doc)).toEqual([
      { id: "0:0", name: "Doc" },
      { id: "1:1", name: "no box" },
      { id: "2:1", name: "M-001 - SIGN", width: 2731, height: 4096 },
    ]);
  });
});

describe("matchNodesToSigns", () => {
  const nodes: FigmaNodeLite[] = [
    { id: "2:1", name: "M-001 - DEF CON REGISTRATION" },
    { id: "2:2", name: "M-002 - AEROSPACE VILLAGE" },
    { id: "2:3", name: "M-010 - CAR HACKING" },
    { id: "2:4", name: "Background" },
  ];

  it("matches by Item-ID prefix and reports the node id + name", () => {
    const r = matchNodesToSigns(nodes, [{ id: 1, itemId: "M-001" }]);
    expect(r.matched).toEqual([
      {
        signId: 1,
        itemId: "M-001",
        nodeId: "2:1",
        nodeName: "M-001 - DEF CON REGISTRATION",
      },
    ]);
    expect(r.unmatchedSigns).toEqual([]);
  });

  it("does not let M-1 match M-10 (trailing-space boundary)", () => {
    const r = matchNodesToSigns(
      [{ id: "x", name: "M-10 - SOMETHING" }],
      [{ id: 1, itemId: "M-1" }],
    );
    expect(r.matched).toEqual([]);
    expect(r.unmatchedSigns).toEqual([{ id: 1, itemId: "M-1" }]);
  });

  it("matches an exact name with no suffix", () => {
    const r = matchNodesToSigns(
      [{ id: "x", name: "M-005" }],
      [{ id: 5, itemId: "M-005" }],
    );
    expect(r.matched[0]?.nodeId).toBe("x");
  });

  it("trims whitespace on the node name before matching", () => {
    const r = matchNodesToSigns(
      [{ id: "x", name: "  M-007 - TRACK 1  " }],
      [{ id: 7, itemId: "M-007" }],
    );
    expect(r.matched[0]?.nodeId).toBe("x");
  });

  it("consumes each node once — two signs can't claim the same node", () => {
    // Pass 1 places sign 1 exactly, leaving ONE pending sibling: the prefix fallback
    // is unambiguous there, and the node sign 1 claimed can't be claimed again.
    const r = matchNodesToSigns(
      [{ id: "x", name: "M-001 - A" }],
      [
        { id: 1, itemId: "M-001", signText: "A" },
        { id: 2, itemId: "M-001", signText: "B" },
      ],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]?.signId).toBe(1);
    expect(r.unmatchedSigns).toEqual([
      { id: 2, itemId: "M-001", signText: "B" },
    ]);
  });

  // Two signs sharing an Item ID that BOTH miss the exact full-name pass are
  // indistinguishable by prefix alone, so claiming by document order silently
  // attaches one sign's art to the other — wrong art on a printed sign, reported as
  // a clean import (#230). Route the whole group to unmatched instead, the stance
  // lib/figma-reconcile.ts already takes with ManifestAmbiguous.
  it("refuses to guess when two signs share an Item ID and neither carries text", () => {
    const r = matchNodesToSigns(
      [
        { id: "x", name: "M-001 - A" },
        { id: "y", name: "M-001 - B" },
      ],
      [
        { id: 1, itemId: "M-001" },
        { id: 2, itemId: "M-001" },
      ],
    );
    expect(r.matched).toEqual([]);
    expect(r.unmatchedSigns).toEqual([
      { id: 1, itemId: "M-001" },
      { id: 2, itemId: "M-001" },
    ]);
    expect(r.unmatchedNodes.map((n) => n.id)).toEqual(["x", "y"]);
  });

  it("refuses to guess when two signs share an Item ID and both texts drifted", () => {
    const r = matchNodesToSigns(
      [
        { id: "x", name: "1001 - DEMO LABS (MOVED)" },
        { id: "y", name: "1001 - SPEAKER PARTY (INVITE ONLY)" },
      ],
      [
        { id: 10, itemId: "1001", signText: "Demo Labs 1" },
        { id: 11, itemId: "1001", signText: "Speaker Party (Demo Labs)" },
      ],
    );
    expect(r.matched).toEqual([]);
    expect(r.unmatchedSigns.map((s) => s.id)).toEqual([10, 11]);
  });

  it("treats a stray trailing space in the Item ID as the same ambiguous group", () => {
    const r = matchNodesToSigns(
      [{ id: "x", name: "M-001 - A" }],
      [
        { id: 1, itemId: "M-001" },
        { id: 2, itemId: "M-001 " },
      ],
    );
    expect(r.matched).toEqual([]);
    expect(r.unmatchedSigns.map((s) => s.id)).toEqual([1, 2]);
  });

  it("reports unmatched signs and unmatched nodes", () => {
    const r = matchNodesToSigns(nodes, [
      { id: 1, itemId: "M-001" },
      { id: 99, itemId: "M-999" },
    ]);
    expect(r.matched.map((m) => m.itemId)).toEqual(["M-001"]);
    expect(r.unmatchedSigns).toEqual([{ id: 99, itemId: "M-999" }]);
    // M-002, M-010, Background remain unconsumed
    expect(r.unmatchedNodes.map((n) => n.id)).toEqual(["2:2", "2:3", "2:4"]);
  });

  // Duplicate Item IDs within a batch are schema-legal and real in the DC34 data
  // (e.g. Item ID 1001 on two 24×36 signs). The Item-ID prefix alone can't tell them
  // apart, so the exact full-name pass ("<Item ID> - <UPPERCASE signText>") must.
  it("disambiguates duplicate Item IDs by full name (never swapped)", () => {
    const dupNodes: FigmaNodeLite[] = [
      { id: "n1", name: "1001 - DEMO LABS 1" },
      { id: "n2", name: "1001 - SPEAKER PARTY (DEMO LABS)" },
    ];
    const r = matchNodesToSigns(dupNodes, [
      { id: 10, itemId: "1001", signText: "Demo Labs 1" },
      { id: 11, itemId: "1001", signText: "Speaker Party (Demo Labs)" },
    ]);
    const bySign = new Map(r.matched.map((m) => [m.signId, m.nodeId]));
    expect(bySign.get(10)).toBe("n1");
    expect(bySign.get(11)).toBe("n2");
    expect(r.unmatchedSigns).toEqual([]);
  });

  it("full-name match is independent of node order", () => {
    // Nodes in the opposite order from the signs — the exact match must still pair
    // each sign with ITS text, not whichever same-Item-ID node comes first.
    const dupNodes: FigmaNodeLite[] = [
      { id: "n2", name: "1001 - SPEAKER PARTY (DEMO LABS)" },
      { id: "n1", name: "1001 - DEMO LABS 1" },
    ];
    const r = matchNodesToSigns(dupNodes, [
      { id: 10, itemId: "1001", signText: "Demo Labs 1" },
      { id: 11, itemId: "1001", signText: "Speaker Party (Demo Labs)" },
    ]);
    const bySign = new Map(r.matched.map((m) => [m.signId, m.nodeId]));
    expect(bySign.get(10)).toBe("n1");
    expect(bySign.get(11)).toBe("n2");
  });

  it("exact matches claim their node before the prefix fallback runs", () => {
    // n2's text drifted from the stored signText (e.g. a Neil edit). The exact pass
    // must first give n1 to sign 10, so the fallback can only place sign 11 on the
    // leftover n2 — the drifted sign can't steal the exact sign's node.
    const dupNodes: FigmaNodeLite[] = [
      { id: "n1", name: "1001 - DEMO LABS 1" },
      { id: "n2", name: "1001 - SPEAKER PARTY (INVITE ONLY)" },
    ];
    const r = matchNodesToSigns(dupNodes, [
      { id: 10, itemId: "1001", signText: "Demo Labs 1" },
      { id: 11, itemId: "1001", signText: "Speaker Party (Demo Labs)" },
    ]);
    const bySign = new Map(r.matched.map((m) => [m.signId, m.nodeId]));
    expect(bySign.get(10)).toBe("n1");
    expect(bySign.get(11)).toBe("n2");
    expect(r.unmatchedSigns).toEqual([]);
  });

  it("falls back to Item-ID prefix for a singleton whose text drifted", () => {
    const r = matchNodesToSigns(
      [{ id: "n", name: "1001 - SPEAKER PARTY (INVITE ONLY)" }],
      [{ id: 11, itemId: "1001", signText: "Speaker Party (Demo Labs)" }],
    );
    expect(r.matched[0]?.nodeId).toBe("n");
    expect(r.matched[0]?.signId).toBe(11);
  });

  it("carries node width/height through to the match (for preview scaling)", () => {
    const r = matchNodesToSigns(
      [{ id: "2:1", name: "M-001 - SIGN", width: 2731, height: 4096 }],
      [{ id: 1, itemId: "M-001" }],
    );
    expect(r.matched[0]).toMatchObject({
      signId: 1,
      nodeId: "2:1",
      width: 2731,
      height: 4096,
    });
  });
});

describe("isAllowedImageHost (SSRF guard)", () => {
  it("allows https Figma hosts + Figma's S3 render bucket", () => {
    expect(isAllowedImageHost("https://www.figma.com/x.png")).toBe(true);
    expect(
      isAllowedImageHost("https://figma-alpha-api.s3.us-west-2.amazonaws.com/x"),
    ).toBe(true);
    expect(
      isAllowedImageHost("https://figma-alpha-api.s3-us-west-2.amazonaws.com/x"),
    ).toBe(true);
    expect(isAllowedImageHost("https://s3-alpha.figma.com/img/y")).toBe(true);
  });

  it("rejects non-Figma AWS buckets (allowlist is the bucket, not *.amazonaws.com)", () => {
    expect(
      isAllowedImageHost("https://attacker-bucket.s3.us-east-1.amazonaws.com/x"),
    ).toBe(false);
    expect(isAllowedImageHost("https://s3.amazonaws.com/figma-alpha-api/x")).toBe(false);
    expect(
      isAllowedImageHost("https://figma-alpha-api.evil.amazonaws.com.evil.com/x"),
    ).toBe(false);
  });

  it("rejects non-https, foreign hosts, and garbage", () => {
    expect(isAllowedImageHost("http://www.figma.com/x.png")).toBe(false);
    expect(isAllowedImageHost("https://evil.com/x.png")).toBe(false);
    expect(isAllowedImageHost("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedImageHost("https://figma.com.evil.com/x")).toBe(false);
    expect(isAllowedImageHost("not a url")).toBe(false);
  });
});
