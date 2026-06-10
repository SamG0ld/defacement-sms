import { describe, it, expect } from "vitest";

import { MAX_IMAGE_BYTES, validateImageUpload } from "@/lib/image-upload";

// Minimal valid headers — enough bytes for the sniffer + dimension parse.
function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // signature
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, then SOF0 segment carrying dimensions.
  const b = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // length
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // components…
  ]);
  return b;
}

function webpBytes(fourcc = "VP8 "): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  b.set([...fourcc].map((c) => c.charCodeAt(0)), 12); // form chunk FourCC
  return b;
}

describe("validateImageUpload — accepts allowlisted image types", () => {
  it("accepts PNG and parses dimensions", () => {
    const r = validateImageUpload(pngBytes(2000, 1414));
    expect(r).toEqual({ ok: true, image: { contentType: "image/png", width: 2000, height: 1414 } });
  });

  it("accepts JPEG and parses dimensions", () => {
    const r = validateImageUpload(jpegBytes(800, 600));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.contentType).toBe("image/jpeg");
      expect(r.image).toMatchObject({ width: 800, height: 600 });
    }
  });

  it("accepts WebP (VP8/VP8L/VP8X) with advisory dimensions left null", () => {
    for (const fourcc of ["VP8 ", "VP8L", "VP8X"]) {
      const r = validateImageUpload(webpBytes(fourcc));
      expect(r).toEqual({ ok: true, image: { contentType: "image/webp", width: null, height: null } });
    }
  });
});

describe("validateImageUpload — rejects everything else", () => {
  it("rejects an empty file", () => {
    expect(validateImageUpload(new Uint8Array(0))).toEqual({ ok: false, error: "empty" });
  });

  it("rejects oversize files before sniffing the type", () => {
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1); // zero-filled, not a real image
    expect(validateImageUpload(tooBig)).toEqual({ ok: false, error: "too_large" });
  });

  it("rejects SVG (XSS vector) and other non-allowlisted types", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(validateImageUpload(svg)).toEqual({ ok: false, error: "unsupported_type" });
  });

  it("rejects a GIF (not allowlisted)", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
    expect(validateImageUpload(gif)).toEqual({ ok: false, error: "unsupported_type" });
  });

  it("rejects a bare RIFF/WEBP shell with no real form chunk", () => {
    expect(validateImageUpload(webpBytes("\0\0\0\0"))).toEqual({
      ok: false,
      error: "unsupported_type",
    });
  });

  it("rejects a file whose extension/MIME lies (random bytes)", () => {
    const bogus = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    expect(validateImageUpload(bogus)).toEqual({ ok: false, error: "unsupported_type" });
  });
});
