// Procedural PNG icons (no image tooling needed): a tilted cinnabar seal on ink, with a motif.
import zlib from 'node:zlib';

const INK = [15, 20, 36, 255], SEAL = [255, 77, 46, 255], WASHI = [237, 232, 222, 255];

/** Bridge arch over a deck (the browser extension). */
export const bridgeMotif = (u, v) => {
  const ax = (u - 0.5) / 0.26, ay = (v - 0.62) / 0.22;
  const arch = Math.abs(ax * ax + ay * ay - 1) < 0.28 && v < 0.62;
  const deck = v > 0.6 && v < 0.67 && u > 0.26 && u < 0.74;
  return arch || deck;
};

/** Three brush bars, shortest on top (the desktop app). */
export const barsMotif = (u, v) =>
  (v > 0.3 && v < 0.37 && u > 0.36 && u < 0.64) || (v > 0.46 && v < 0.53 && u > 0.31 && u < 0.69) || (v > 0.62 && v < 0.7 && u > 0.26 && u < 0.74);

export function sealPng(size, motif = bridgeMotif) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, a = (-4 * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // rotate into the seal's frame
    const dx = x - c, dy = y - c;
    const u = (dx * cos + dy * sin) / size + 0.5, v = (-dx * sin + dy * cos) / size + 0.5;
    let col = [0, 0, 0, 0];
    if (u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92) {
      const border = u < 0.18 || u > 0.82 || v < 0.18 || v > 0.82;
      col = border ? SEAL : motif(u, v) ? WASHI : INK;
    }
    px.set(col, (y * size + x) * 4);
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
