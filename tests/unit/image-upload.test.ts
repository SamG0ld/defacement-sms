import { describe, it, expect } from "vitest";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  validateImageUpload,
} from "@/lib/image-upload";

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

function webpShell(fourcc: string, size = 16): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  b.set([...fourcc].map((c) => c.charCodeAt(0)), 12); // form chunk FourCC
  return b;
}

function webpVp8Bytes(width: number, height: number): Uint8Array {
  const b = webpShell("VP8 ", 30);
  b.set([0x9d, 0x01, 0x2a], 23); // start code
  b[26] = width & 0xff;
  b[27] = (width >> 8) & 0x3f;
  b[28] = height & 0xff;
  b[29] = (height >> 8) & 0x3f;
  return b;
}

function webpVp8lBytes(width: number, height: number): Uint8Array {
  const b = webpShell("VP8L", 25);
  b[20] = 0x2f; // signature
  const bits = (width - 1) | ((height - 1) << 14);
  b[21] = bits & 0xff;
  b[22] = (bits >>> 8) & 0xff;
  b[23] = (bits >>> 16) & 0xff;
  b[24] = (bits >>> 24) & 0xff;
  return b;
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const b = webpShell("VP8X", 30);
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
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

  it("accepts WebP and parses dimensions from each form chunk", () => {
    expect(validateImageUpload(webpVp8Bytes(640, 480))).toEqual({
      ok: true,
      image: { contentType: "image/webp", width: 640, height: 480 },
    });
    expect(validateImageUpload(webpVp8lBytes(1024, 768))).toEqual({
      ok: true,
      image: { contentType: "image/webp", width: 1024, height: 768 },
    });
    expect(validateImageUpload(webpVp8xBytes(3000, 2000))).toEqual({
      ok: true,
      image: { contentType: "image/webp", width: 3000, height: 2000 },
    });
  });
});

describe("validateImageUpload — decompression-bomb ceiling", () => {
  it("accepts dimensions exactly at the pixel ceiling", () => {
    // 8000 * 5000 = 40,000,000 = MAX_IMAGE_PIXELS
    expect(8000 * 5000).toBe(MAX_IMAGE_PIXELS);
    expect(validateImageUpload(pngBytes(8000, 5000)).ok).toBe(true);
  });

  it("rejects a PNG pixel bomb over the ceiling", () => {
    expect(validateImageUpload(pngBytes(9000, 9000))).toEqual({
      ok: false,
      error: "too_many_pixels",
    });
  });

  it("rejects a JPEG over the ceiling", () => {
    expect(validateImageUpload(jpegBytes(8000, 5001))).toEqual({
      ok: false,
      error: "too_many_pixels",
    });
  });

  it("rejects a WebP (VP8X) pixel bomb — 16383x16383 via extended header", () => {
    expect(validateImageUpload(webpVp8xBytes(16383, 16383))).toEqual({
      ok: false,
      error: "too_many_pixels",
    });
  });

  it("rejects an allowlisted type whose dimensions can't be read", () => {
    // Truncated PNG: signature only, no IHDR payload.
    const truncatedPng = new Uint8Array(16);
    truncatedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateImageUpload(truncatedPng)).toEqual({
      ok: false,
      error: "bad_dimensions",
    });
    // WebP form chunk with no parseable header payload.
    expect(validateImageUpload(webpShell("VP8 "))).toEqual({
      ok: false,
      error: "bad_dimensions",
    });
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
    expect(validateImageUpload(webpShell("\0\0\0\0"))).toEqual({
      ok: false,
      error: "unsupported_type",
    });
  });

  it("rejects a file whose extension/MIME lies (random bytes)", () => {
    const bogus = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    expect(validateImageUpload(bogus)).toEqual({ ok: false, error: "unsupported_type" });
  });
});
