#!/usr/bin/env node
// Builds the VoidCode brand icon (assets/icon.png + assets/icon.ico).
// Pure Node — no image deps. Draws the ◢◤ "void" mark on a rounded dark tile.
//
// Icon design:
//   background  : #0D1117 (rounded-rect tile)
//   border      : #30363D
//   mark glyphs : #58A6FF  (blue) + #C9D1D9 (light) accent
//
// Usage: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const OUT_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const OUT_ICO = path.join(__dirname, '..', 'assets', 'icon.ico');
const R = 0.18; // corner radius as fraction of size

// ── tiny PNG encoder (RGBA, no compression beyond filter None) ──────────
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── drawing ---------------------------------------------------------------
function inRoundedRect(x, y, s, r) {
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x > s - 1 - r && y < r) return (x - (s - 1 - r)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y > s - 1 - r) return (x - r) ** 2 + (y - (s - 1 - r)) ** 2 <= r * r;
  if (x > s - 1 - r && y > s - 1 - r) return (x - (s - 1 - r)) ** 2 + (y - (s - 1 - r)) ** 2 <= r * r;
  return true;
}
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
function drawIcon(s) {
  const buf = Buffer.alloc(s * s * 4);
  const BG = hex('#0D1117'), BD = hex('#30363D'), ACC = hex('#58A6FF'), LIGHT = hex('#C9D1D9');
  const r = Math.max(1, Math.round(R * s));
  // pixel-center sample: use center of each pixel in unit coords [0,s)
  const inside = (px, py) => {
    const x = px + 0.5, y = py + 0.5; // center of pixel
    return inRoundedRect(x - 0.5, y - 0.5, s - 1, r);
  };
  // supersample 2x2 for anti-aliased rounded edge
  const cover = (px, py) => {
    let c = 0; const offs = [0, 0.5];
    for (const ox of offs) for (const oy of offs) if (inside(px + ox, py + oy)) c++;
    return c / 4;
  };
  // helper: is this pixel (centered) inside a rectangle
  function inRect(cx0, cy0, w, h, x, y) {
    return x >= cx0 && x < cx0 + w && y >= cy0 && y < cy0 + h;
  }
  // mark geometry (× — "void" chevrons pair)
  // left glyph ◢ : triangle from (0.22,0.22)->(0.44,0.78)->(0.36,0.78)
  function inLeft(x, y) {
    const x0 = 0.26 * s, x1 = 0.42 * s, yTop = 0.22 * s, yBot = 0.78 * s;
    // diagonal edge
    const t = (y - yTop) / (yBot - yTop); // 0..1 down
    const xEdge = x0 + (x1 - x0) * t;
    return x >= x0 && x <= xEdge && y >= yTop && y <= yBot;
  }
  function inRight(x, y) {
    const x1 = 0.58 * s, x2 = 0.74 * s, yTop = 0.22 * s, yBot = 0.78 * s;
    const t = (y - yTop) / (yBot - yTop);
    const xEdge = x2 - (x2 - x1) * t;
    return x >= xEdge && x <= x2 && y >= yTop && y <= yBot;
  }
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const cov = cover(x, y);
      if (cov <= 0.02) { buf[i + 3] = 0; continue; } // outside tile → transparent
      let col = BG;
      // border ring ~ (1.5% of size)
      const ring = Math.max(1, Math.round(0.015 * s));
      const onBorder = inside(x, y) && (
        x < ring || y < ring || x > s - 1 - ring || y > s - 1 - ring
      );
      if (onBorder) col = BD;
      else if (inLeft(x + 0.5, y + 0.5)) col = ACC;
      else if (inRight(x + 0.5, y + 0.5)) col = LIGHT;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = Math.round(255 * cov);
    }
  }
  return buf;
}

// ── ico packing ──────────────────────────────────────────────────────────
function packICO(sizesMap) {
  const entries = [];
  const ordered = Object.keys(sizesMap).map(Number).sort((a, b) => a - b);
  let offset = 6 + ordered.length * 16;
  const bodies = [];
  const frames = [];
  for (const s of ordered) {
    const buf = sizesMap[s];
    if (s >= 256) {
      // PNG-compressed entry (Vista+) — store as PNG directly
      const png = encodePNG(s, s, buf);
      frames.push({ w: 0, h: 0, png }); // 0 means 256 in ICO
    } else {
      // BMP (DIB) entry: header + BGRA rows bottom-up
      const hdr = Buffer.alloc(40);
      hdr.writeInt32LE(40, 0); hdr.writeInt32LE(s, 4); hdr.writeInt32LE(s * 2, 8);
      hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
      hdr.writeInt32LE(s * s * 4, 20);
      const and = Buffer.alloc(s * ((s + 31) >> 5) * 4); // allocate AND mask (unused, all 0)
      const bmp = Buffer.alloc(40 + s * s * 4);
      hdr.copy(bmp, 0);
      // BGRA bottom-up
      for (let yy = 0; yy < s; yy++) {
        const srcRow = (s - 1 - yy) * s * 4;
        buf.copy(bmp, 40 + yy * s * 4, srcRow, srcRow + s * 4);
        for (let xx = 0; xx < s; xx++) {
          const p = 40 + yy * s * 4 + xx * 4;
          const r = buf[srcRow + xx * 4], g = buf[srcRow + xx * 4 + 1], b = buf[srcRow + xx * 4 + 2], a = buf[srcRow + xx * 4 + 3];
          bmp[p] = b; bmp[p + 1] = g; bmp[p + 2] = r; bmp[p + 3] = a;
        }
      }
      frames.push({ w: s, h: s, png: Buffer.concat([bmp, and]) });
      // note: AND mask zeros → opaque (fine; we handle alpha via 32bpp)
    }
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e[0] = f.w >= 256 ? 0 : f.w; e[1] = f.h >= 256 ? 0 : f.h;
    e[2] = 0; e[3] = 0; // palette
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); // planes, bpp
    e.writeUInt32LE(f.png.length, 8); e.writeUInt32LE(offset, 12);
    offset += f.png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

// ── main ─────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
const pngs = {};            // size -> rgba buffer
for (const s of SIZES) {
  const rgba = drawIcon(s);
  pngs[s] = rgba;
  console.log(`drew ${s}x${s}`);
}
// Write the 512 PNG (the main icon.png)
fs.writeFileSync(OUT_PNG, encodePNG(512, 512, pngs[512]));
console.log('wrote', OUT_PNG);
// Write the multi-size ICO
fs.writeFileSync(OUT_ICO, packICO(pngs));
console.log('wrote', OUT_ICO);
