// Dependency-free PNG encoder (stored deflate – the PPTX zip compresses it)
// and image dimension sniffing for PNG / JPEG / GIF.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(rgba, width, height) {
  const rowLen = width * 4 + 1;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowLen + 1);
  }
  // zlib stream with stored blocks
  const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  let p = 0;
  z[p++] = 0x78; z[p++] = 0x01;
  for (let b = 0; b < nBlocks; b++) {
    const start = b * 65535, len = Math.min(65535, raw.length - start);
    z[p++] = b === nBlocks - 1 ? 1 : 0;
    z[p++] = len & 0xff; z[p++] = len >>> 8;
    z[p++] = ~len & 0xff; z[p++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(start, start + len), p); p += len;
  }
  let a = 1, b2 = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b2 = (b2 + a) % 65521; }
  const adler = ((b2 << 16) | a) >>> 0;
  z[p++] = adler >>> 24; z[p++] = (adler >>> 16) & 0xff; z[p++] = (adler >>> 8) & 0xff; z[p++] = adler & 0xff;

  const chunks = [];
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  chunk("IHDR", ihdr);
  chunk("IDAT", z.subarray(0, p));
  chunk("IEND", new Uint8Array(0));
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const total = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Returns {ext, width, height} or null if the format is unknown.
export function imageInfo(buf) {
  const u = buf;
  if (u.length > 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    return { ext: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (u.length > 10 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) {
    return { ext: "gif", width: u[6] | (u[7] << 8), height: u[8] | (u[9] << 8) };
  }
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xff) { i++; continue; }
      const marker = u[i + 1];
      const len = (u[i + 2] << 8) | u[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ext: "jpeg", height: (u[i + 5] << 8) | u[i + 6], width: (u[i + 7] << 8) | u[i + 8] };
      }
      i += 2 + len;
    }
    return { ext: "jpeg", width: 1, height: 1 };
  }
  return null;
}
