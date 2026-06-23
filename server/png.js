// Минимальный рендер генплана в PNG без внешних зависимостей (только zlib из
// Node). Рисуем участок, сетку, цветные пронумерованные зоны — чтобы vision-
// модель могла «увидеть» план и оценить компоновку. Текстовая легенда (номер→
// название) отдаётся отдельно в результате инструмента.

import { deflateSync } from 'node:zlib';

// ── CRC32 для PNG-чанков ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgba: Uint8Array длиной width*height*4. Возвращает Buffer PNG.
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Каждая строка с фильтр-байтом 0 в начале.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray ? raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
                  : raw.set(rgba.slice(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Холст ──
function makeCanvas(w, h, bg) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
  }
  return px;
}
function setPx(px, w, h, x, y, r, g, b, a = 1) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  px[i] = Math.round(px[i] * (1 - a) + r * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
  px[i + 3] = 255;
}
function fillRect(px, w, h, x0, y0, rw, rh, col, a) {
  for (let y = y0; y < y0 + rh; y++)
    for (let x = x0; x < x0 + rw; x++) setPx(px, w, h, x, y, col[0], col[1], col[2], a);
}
function strokeRect(px, w, h, x0, y0, rw, rh, col, t = 2) {
  for (let k = 0; k < t; k++) {
    for (let x = x0; x < x0 + rw; x++) { setPx(px, w, h, x, y0 + k, ...col); setPx(px, w, h, x, y0 + rh - 1 - k, ...col); }
    for (let y = y0; y < y0 + rh; y++) { setPx(px, w, h, x0 + k, y, ...col); setPx(px, w, h, x0 + rw - 1 - k, y, ...col); }
  }
}

// ── Шрифт цифр 3x5 (по строкам, 3 бита) ──
const DIGITS = {
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b010, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
};
function drawDigit(px, w, h, ch, x, y, scale, col) {
  const g = DIGITS[ch];
  if (!g) return;
  for (let row = 0; row < 5; row++)
    for (let c = 0; c < 3; c++)
      if (g[row] & (1 << (2 - c)))
        fillRect(px, w, h, x + c * scale, y + row * scale, scale, scale, col, 1);
}
function drawNumber(px, w, h, n, cx, cy, scale, col) {
  const s = String(n);
  const dw = 3 * scale, gap = scale;
  const total = s.length * dw + (s.length - 1) * gap;
  let x = Math.round(cx - total / 2);
  const y = Math.round(cy - (5 * scale) / 2);
  for (const ch of s) { drawDigit(px, w, h, ch, x, y, scale, col); x += dw + gap; }
}

function parseHex(hex, fallback) {
  if (typeof hex === 'string') {
    const m = hex.replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(m)) return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  }
  return fallback;
}
const PALETTE = [
  [79, 140, 255], [16, 185, 129], [249, 115, 22], [168, 85, 247], [236, 72, 153],
  [14, 165, 233], [234, 179, 8], [239, 68, 68], [20, 184, 166], [139, 92, 246],
];

// Главное: отрисовать генплан в PNG. Возвращает { mediaType, data(base64), legend }.
export function renderBlueprintPNG(bp) {
  const items = Array.isArray(bp.items) ? bp.items : [];
  let W = Number(bp.width) || 0, D = Number(bp.depth) || 0;
  for (const it of items) {
    W = Math.max(W, (Number(it.x) || 0) + (Number(it.w) || 0));
    D = Math.max(D, (Number(it.z) || 0) + (Number(it.d) || 0));
  }
  W = W || 64; D = D || 64;
  const SIZE = 480, pad = 24;
  const sc = (SIZE - pad * 2) / Math.max(W, D);
  const px = makeCanvas(SIZE, SIZE, [22, 24, 30]);
  // Поле участка.
  fillRect(px, SIZE, SIZE, pad, pad, Math.round(W * sc), Math.round(D * sc), [30, 33, 42], 1);
  // Сетка каждые 16 studs.
  const grid = [60, 64, 74];
  for (let g = 0; g <= Math.max(W, D); g += 16) {
    const gx = pad + g * sc, gy = pad + g * sc;
    if (g <= W) for (let y = pad; y < pad + D * sc; y++) setPx(px, SIZE, SIZE, gx, y, ...grid, 0.5);
    if (g <= D) for (let x = pad; x < pad + W * sc; x++) setPx(px, SIZE, SIZE, x, gy, ...grid, 0.5);
  }
  const legend = [];
  items.forEach((it, i) => {
    const col = parseHex(it.color, PALETTE[i % PALETTE.length]);
    const x = pad + (Number(it.x) || 0) * sc, y = pad + (Number(it.z) || 0) * sc;
    const rw = Math.max(3, Math.abs(Number(it.w) || 1) * sc), rh = Math.max(3, Math.abs(Number(it.d) || 1) * sc);
    fillRect(px, SIZE, SIZE, Math.round(x), Math.round(y), Math.round(rw), Math.round(rh), col, 0.32);
    strokeRect(px, SIZE, SIZE, Math.round(x), Math.round(y), Math.round(rw), Math.round(rh), col, 2);
    drawNumber(px, SIZE, SIZE, i + 1, x + rw / 2, y + rh / 2, Math.max(2, Math.round(Math.min(rw, rh) / 14)), [255, 255, 255]);
    legend.push(`${i + 1}. ${it.label || 'зона'} (${Number(it.w) || 0}×${Number(it.d) || 0})`);
  });
  const buf = encodePNG(SIZE, SIZE, px);
  return { mediaType: 'image/png', data: buf.toString('base64'), legend, W, D };
}
