// Generate ghostHR ghost icon PNGs at multiple sizes (no external deps).
// Draws a rounded ghost (SVG-path-style) with two eyes onto RGBA pixels,
// then encodes PNG via Node's built-in zlib.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../src/icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder ----
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- ghost geometry ----
// SDF-ish: inside test with soft edge for anti-aliasing.
function ghostAlpha(x, y, S) {
  const cx = 0.5 * S, cy = 0.5 * S;
  const r = 0.5 * S;           // head circle radius (diameter = full width)
  const head = 0.62 * S;       // circle center y
  const dx = x - cx, dy = y - head;
  const dCircle = Math.max(0, Math.sqrt(dx * dx + dy * dy) - r);
  // body below head: rectangle down to bottom with rounded wavy edge
  const bodyTop = head + r * 0.15;
  let dBody = Infinity;
  if (y > bodyTop) {
    const half = r * 0.8;
    // left/right boundaries
    const dEdge = Math.max(Math.abs(x - cx) - half, 0);
    // scalloped bottom: three rounded bumps
    const bumps = 3;
    const bw = (2 * half) / bumps;
    let dBot = Infinity;
    for (let i = 0; i < bumps; i++) {
      const bx = cx - half + bw * (i + 0.5);
      const by = S;
      const br = bw * 0.42;
      const d = Math.sqrt((x - bx) ** 2 + (y - by) ** 2) - br;
      if (d < dBot) dBot = d;
    }
    const dTop = bodyTop - y;
    dBody = Math.max(dEdge, dBot, dTop);
  }
  const d = Math.min(dCircle, dBody);
  // 1px smooth edge
  return Math.max(0, Math.min(1, 1 - d));
}

function render(S) {
  const rgba = Buffer.alloc(S * S * 4);
  const eyeR = 0.11 * S;
  const ey = 0.5 * S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const a = ghostAlpha(x + 0.5, y + 0.5, S);
      const i = (y * S + x) * 4;
      // accent gradient: sky -> soft violet for the ghost body
      const t = y / S;
      const gr = Math.round(56 + (129 - 56) * t);
      const gg = Math.round(189 + (140 - 189) * t);
      const gb = Math.round(248 + (248 - 248) * t);
      // eyes (dark)
      const le = Math.hypot(x + 0.5 - (0.5 * S - 0.22 * S), y + 0.5 - ey);
      const re = Math.hypot(x + 0.5 - (0.5 * S + 0.22 * S), y + 0.5 - ey);
      const eyeA = Math.max(0, Math.min(1, 1 - (le - eyeR))) + Math.max(0, Math.min(1, 1 - (re - eyeR)));
      rgba[i] = gr; rgba[i + 1] = gg; rgba[i + 2] = gb;
      rgba[i + 3] = Math.round(a * 255);
      if (eyeA > 0) {
        // dark eyes on top of body
        rgba[i] = Math.round(rgba[i] * (1 - eyeA) + 10 * eyeA);
        rgba[i + 1] = Math.round(rgba[i + 1] * (1 - eyeA) + 23 * eyeA);
        rgba[i + 2] = Math.round(rgba[i + 2] * (1 - eyeA) + 42 * eyeA);
      }
    }
  }
  return rgba;
}

for (const size of [16, 32, 48, 128]) {
  const rgba = render(size);
  const png = encodePNG(size, size, rgba);
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
