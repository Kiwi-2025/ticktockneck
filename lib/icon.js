const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
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

// 16x16 RGBA solid teal icon. No external asset file needed.
function createIconBuffer() {
  const W = 16, H = 16;
  const R = 0x14, G = 0xB8, B = 0xA6, A = 0xFF;
  const row = Buffer.alloc(1 + W * 4);
  row[0] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const o = 1 + x * 4;
    row[o] = R; row[o + 1] = G; row[o + 2] = B; row[o + 3] = A;
  }
  const raw = Buffer.concat(Array.from({ length: H }, () => row));
  const idat = zlib.deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { createIconBuffer };
