import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    let byte = buf[i];
    for (let j = 0; j < 8; j++) {
      if ((crc ^ byte) & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
      byte >>>= 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  const toCrc = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPng(size) {
  const width = size;
  const height = size;

  // IHDR: 13 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowLength = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowLength);

  const cx = width / 2;
  const cy = height / 2;
  const rOuter = width * 0.44;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLength;
    rawData[rowOffset] = 0; // No filter

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background rounded shape / circle
      if (dist <= rOuter) {
        // Base dark blue gradient
        const gradRatio = y / height;
        let r = Math.round(10 + gradRatio * 7);
        let g = Math.round(14 + gradRatio * 10);
        let b = Math.round(26 + gradRatio * 15);
        let a = 255;

        // Outer ring accent
        if (Math.abs(dist - rOuter * 0.85) < width * 0.015) {
          r = 59;
          g = 130;
          b = 246;
          a = 180;
        }

        // Vertical Arrows (Send & Receive)
        const inLeftCol = x >= cx - width * 0.22 && x <= cx - width * 0.08;
        const inRightCol = x >= cx + width * 0.08 && x <= cx + width * 0.22;
        const inArrowY = y >= cy - height * 0.25 && y <= cy + height * 0.25;

        if ((inLeftCol || inRightCol) && inArrowY) {
          // Arrow shafts
          r = 96;
          g = 165;
          b = 250;
          a = 255;
        }

        // Center dot
        if (dist <= width * 0.05) {
          r = 147;
          g = 197;
          b = 253;
          a = 255;
        }

        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
        rawData[pxOffset + 3] = a;
      } else {
        // Transparent outside
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      }
    }
  }

  const deflated = zlib.deflateSync(rawData);

  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', deflated);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngHeader, ihdrChunk, idatChunk, iendChunk]);
}

async function main() {
  const iconsDir = path.join(process.cwd(), 'public', 'icons');
  await fs.promises.mkdir(iconsDir, { recursive: true });

  const png192 = createPng(192);
  await fs.promises.writeFile(path.join(iconsDir, 'icon-192.png'), png192);
  console.log('Created public/icons/icon-192.png (192x192,', png192.length, 'bytes)');

  const png512 = createPng(512);
  await fs.promises.writeFile(path.join(iconsDir, 'icon-512.png'), png512);
  console.log('Created public/icons/icon-512.png (512x512,', png512.length, 'bytes)');
}

main().catch(console.error);
