/**
 * Generate resources/icon.png — a 128×128 PNG for the VS Code Marketplace.
 *
 * Pure Node (zlib only). No sharp/canvas dependency. Writes a solid-branded
 * tile with a simple "M" mark so the marketplace listing is not a blank square.
 *
 * Usage: node scripts/generate-icon.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO_ROOT, 'resources', 'icon.png');
const SIZE = 128;

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type 4-char chunk type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Whether pixel (x,y) is inside a simple block-letter "M" mark.
 * @param {number} x
 * @param {number} y
 */
function isMark(x, y) {
  const left = 30;
  const right = 97;
  const top = 28;
  const bottom = 100;
  const stroke = 14;
  if (y < top || y > bottom || x < left || x > right) return false;

  if (x >= left && x < left + stroke) return true;
  if (x > right - stroke && x <= right) return true;

  const mid = (left + right) / 2;
  const relY = y - top;
  const maxY = 48;
  if (relY <= maxY) {
    const half = (relY / maxY) * ((right - left) / 2 - stroke / 2);
    const dist = Math.abs(x - mid);
    if (dist >= half && dist <= half + stroke) return true;
  }
  return false;
}

function buildRgbaRows() {
  const bg = [0x14, 0x1b, 0x2d, 0xff]; // #141b2d
  const fg = [0xf0, 0xb4, 0x29, 0xff]; // #f0b429
  const rows = [];
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0; // filter None
    for (let x = 0; x < SIZE; x += 1) {
      const c = isMark(x, y) ? fg : bg;
      const o = 1 + x * 4;
      row[o] = c[0];
      row[o + 1] = c[1];
      row[o + 2] = c[2];
      row[o + 3] = c[3];
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function buildPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(buildRgbaRows(), { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(path.dirname(OUT), { recursive: true });
const png = buildPng();
writeFileSync(OUT, png);
const hash = createHash('sha256').update(png).digest('hex').slice(0, 12);
console.log(
  JSON.stringify({
    path: path.relative(REPO_ROOT, OUT).replace(/\\/g, '/'),
    bytes: png.length,
    width: SIZE,
    height: SIZE,
    sha256_12: hash,
  }),
);
