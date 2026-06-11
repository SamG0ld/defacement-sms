import { describe, it, expect } from "vitest";

import { figmaFileKey, isAllowedImageHost } from "@/lib/figma";
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
    const r = matchNodesToSigns(
      [{ id: "x", name: "M-001 - A" }],
      [
        { id: 1, itemId: "M-001" },
        { id: 2, itemId: "M-001" },
      ],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]?.signId).toBe(1);
    expect(r.unmatchedSigns).toEqual([{ id: 2, itemId: "M-001" }]);
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
});

describe("isAllowedImageHost (SSRF guard)", () => {
  it("allows https Figma + AWS hosts", () => {
    expect(isAllowedImageHost("https://www.figma.com/x.png")).toBe(true);
    expect(
      isAllowedImageHost("https://figma-alpha-api.s3.us-west-2.amazonaws.com/x"),
    ).toBe(true);
    expect(isAllowedImageHost("https://s3-alpha.figma.com/img/y")).toBe(true);
  });

  it("rejects non-https, foreign hosts, and garbage", () => {
    expect(isAllowedImageHost("http://www.figma.com/x.png")).toBe(false);
    expect(isAllowedImageHost("https://evil.com/x.png")).toBe(false);
    expect(isAllowedImageHost("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedImageHost("https://figma.com.evil.com/x")).toBe(false);
    expect(isAllowedImageHost("not a url")).toBe(false);
  });
});
