// Validation for admin-uploaded floor map images. The security stance: never
// trust the client. The browser-supplied MIME type and filename are ignored —
// the real type is sniffed from the file's magic bytes, and only a small
// allowlist (PNG / JPEG / WebP) is accepted. Everything else (SVG, HTML, an
// .exe renamed .png, a zip bomb) is rejected before it ever reaches the DB or
// gets served back with an attacker-chosen content type.
//
// Pure (operates on bytes, no DB/IO) so it's unit-testable and reusable.

// Floor plans are well under 1 MB today; cap generously for high-res hall maps
// while still bounding what a single request can push into the DB.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// Decoded-size ceiling (decompression-bomb guard). The byte cap alone still
// admits a highly-compressed PNG/WebP that decodes to gigabytes of RGBA in
// every viewer's <img> tab. 40M px (~8K x 5K) is ~160 MB decoded — generous
// for any real floor map or deploy photo, cheap to enforce from the header.
export const MAX_IMAGE_PIXELS = 40_000_000;

export type SniffedImage = {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

export type ImageValidationError =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "bad_dimensions"
  | "too_many_pixels";

export type ImageValidationResult =
  | { ok: true; image: SniffedImage }
  | { ok: false; error: ImageValidationError };

function isPng(b: Uint8Array): boolean {
  return (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  );
}

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isWebp(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46; // "RIFF"
  const webp = b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "WEBP"
  if (!riff || !webp) return false;
  // Require a real WebP form chunk — reject a bare RIFF/WEBP shell wrapping an
  // arbitrary (non-image) body. VP8 = lossy, VP8L = lossless, VP8X = extended.
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  return fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "VP8X";
}

function u16be(b: Uint8Array, off: number): number {
  return (b[off] << 8) | b[off + 1];
}
function u32be(b: Uint8Array, off: number): number {
  return (b[off] * 0x1000000) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3];
}
function u16le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function u24le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16);
}

function pngDimensions(b: Uint8Array): { width: number | null; height: number | null } {
  if (b.length < 24) return { width: null, height: null };
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

// Walk JPEG segments to the Start-Of-Frame marker, which carries the dimensions.
function jpegDimensions(b: Uint8Array): { width: number | null; height: number | null } {
  let off = 2; // past SOI (FFD8)
  // Need bytes off..off+8 (the SOF width field ends at off+8).
  while (off + 8 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    // SOF0–SOF15 carry frame dimensions, except the non-frame markers in that
    // numeric range: DHT (C4), JPG (C8), DAC (CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // segment: FF, marker, len(2), precision(1), height(2), width(2)
      return { height: u16be(b, off + 5), width: u16be(b, off + 7) };
    }
    // Standalone markers (RSTn D0–D7, SOI D8, EOI D9) have no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const segLen = u16be(b, off + 2);
    if (segLen < 2) break; // malformed; stop rather than loop
    off += 2 + segLen;
  }
  return { width: null, height: null };
}

// WebP dimensions, by form chunk (payload starts at byte 20, after the RIFF
// header and the chunk's FourCC + size):
//   VP8  (lossy):    3-byte frame tag, start code 9D 01 2A, then 14-bit LE
//                    width/height at +6 / +8.
//   VP8L (lossless): 0x2F signature byte, then width-1 / height-1 packed as
//                    14+14 bits little-endian.
//   VP8X (extended): flags + reserved (4 bytes), then 24-bit LE canvas
//                    width-1 / height-1.
function webpDimensions(b: Uint8Array): { width: number | null; height: number | null } {
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return { width: null, height: null };
    }
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (b.length < 25 || b[20] !== 0x2f) return { width: null, height: null };
    const bits =
      b[21] | (b[22] << 8) | (b[23] << 16) | ((b[24] & 0x0f) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") {
    if (b.length < 30) return { width: null, height: null };
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return { width: null, height: null };
}

// Validate an uploaded image's bytes. Returns the sniffed (trusted) content type
// + parsed dimensions, or a specific error code the caller maps to a message.
// Dimensions are enforced, not advisory: an allowlisted type whose header won't
// yield them is malformed/truncated and gets rejected, and the pixel ceiling
// bounds what every viewer's <img> must decode.
export function validateImageUpload(bytes: Uint8Array): ImageValidationResult {
  if (bytes.length === 0) return { ok: false, error: "empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "too_large" };

  let contentType: SniffedImage["contentType"];
  let dims: { width: number | null; height: number | null };
  if (isPng(bytes)) {
    contentType = "image/png";
    dims = pngDimensions(bytes);
  } else if (isJpeg(bytes)) {
    contentType = "image/jpeg";
    dims = jpegDimensions(bytes);
  } else if (isWebp(bytes)) {
    contentType = "image/webp";
    dims = webpDimensions(bytes);
  } else {
    return { ok: false, error: "unsupported_type" };
  }

  if (!dims.width || !dims.height || dims.width <= 0 || dims.height <= 0) {
    return { ok: false, error: "bad_dimensions" };
  }
  if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
    return { ok: false, error: "too_many_pixels" };
  }
  return {
    ok: true,
    image: { contentType, width: dims.width, height: dims.height },
  };
}
