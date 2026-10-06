// Font files -> metadata, Figma style matching and Embedded OpenType (.fntdata) for PPTX embedding.

function u16(dv, o) { return dv.getUint16(o); }
function u32(dv, o) { return dv.getUint32(o); }
function i16(dv, o) { return dv.getInt16(o); }

function readNames(dv, bytes, off) {
  const count = u16(dv, off + 2), strOff = off + u16(dv, off + 4);
  const best = {};
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platform = u16(dv, r), enc = u16(dv, r + 2), lang = u16(dv, r + 4), id = u16(dv, r + 6);
    const len = u16(dv, r + 8), so = strOff + u16(dv, r + 10);
    let score = 0, text = "";
    if (platform === 3 && (enc === 1 || enc === 0)) {
      score = lang === 0x409 ? 3 : 2;
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(u16(dv, so + k));
    } else if (platform === 1 && enc === 0) {
      score = 1;
      for (let k = 0; k < len; k++) text += String.fromCharCode(bytes[so + k]);
    } else continue;
    if (!best[id] || best[id].score < score) best[id] = { score, text };
  }
  const out = {};
  for (const [id, v] of Object.entries(best)) out[id] = v.text;
  return out;
}

// Parses a TrueType/OpenType font. Throws on unsupported input.
export function parseFont(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = u32(dv, 0);
  if (tag === 0x74746366) throw new Error("Kolekce písem (.ttc) nelze vložit – použijte jednotlivé .ttf soubory.");
  if (tag === 0x774f4646 || tag === 0x774f4632) throw new Error("WOFF/WOFF2 nelze vložit – použijte .ttf soubor.");
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) throw new Error("Neznámý formát písma.");
  const numTables = u16(dv, 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    const t = String.fromCharCode(u8[r], u8[r + 1], u8[r + 2], u8[r + 3]);
    tables[t] = { off: u32(dv, r + 8), len: u32(dv, r + 12) };
  }
  if (!tables.name || !tables["OS/2"] || !tables.head || !tables.hhea) throw new Error("Písmu chybí povinné tabulky.");
  const names = readNames(dv, u8, tables.name.off);
  const os2 = tables["OS/2"].off, head = tables.head.off, hhea = tables.hhea.off;
  const fsSelection = u16(dv, os2 + 62), macStyle = u16(dv, head + 44);
  const info = {
    legacyFamily: names[1] || names[16] || "",
    subfamily: names[2] || "Regular",
    family: names[16] || names[1] || "",
    style: names[17] || names[2] || "Regular",
    fullName: names[4] || names[1] || "",
    version: names[5] || "Version 1.0",
    weight: u16(dv, os2 + 4),
    fsType: u16(dv, os2 + 8),
    panose: Array.from(u8.subarray(os2 + 32, os2 + 42)),
    unicodeRange: [u32(dv, os2 + 42), u32(dv, os2 + 46), u32(dv, os2 + 50), u32(dv, os2 + 54)],
    codePageRange: u16(dv, os2) >= 1 ? [u32(dv, os2 + 78), u32(dv, os2 + 82)] : [1, 0],
    italic: !!(fsSelection & 1) || !!(macStyle & 2),
    bold: !!(fsSelection & 0x20) || !!(macStyle & 1),
    checkSumAdjustment: u32(dv, head + 8),
    unitsPerEm: u16(dv, head + 18),
    ascender: i16(dv, hhea + 4),
    descender: i16(dv, hhea + 6),
    isCFF: tag === 0x4f54544f,
    isVariable: !!tables.fvar,
    bytes: u8,
  };
  if (info.fsType & 0x0002 && !(info.fsType & 0x000c)) {
    throw new Error(`Licence písma „${info.fullName}“ zakazuje vkládání do dokumentů (fsType restricted).`);
  }
  if (info.fsType & 0x0200) throw new Error(`Písmo „${info.fullName}“ povoluje vložení jen jako bitmapu.`);
  return info;
}

// EOT 2.2 container (uncompressed font data) as written into ppt/fonts/*.fntdata.
export function makeEot(info) {
  const enc = (s) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 0xff; b[i * 2 + 1] = s.charCodeAt(i) >> 8; }
    return b;
  };
  const fam = enc(info.legacyFamily), sty = enc(info.subfamily), ver = enc(info.version), full = enc(info.fullName);
  const font = info.bytes;
  const headerLen = 80 + (2 + 2 + fam.length) + (2 + 2 + sty.length) + (2 + 2 + ver.length) + (2 + 2 + full.length) +
    (2 + 2) + 4 + 4 + (2 + 2) + 4 + 4;
  const total = headerLen + font.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  const w32 = (v) => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const w16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  const w8 = (v) => { out[o++] = v; };
  const wstr = (b) => { w16(b.length); out.set(b, o); o += b.length; };
  w32(total);                 // EOTSize
  w32(font.length);           // FontDataSize
  w32(0x00020002);            // Version 2.2
  w32(0);                     // Flags: uncompressed, no XOR
  for (let i = 0; i < 10; i++) w8(info.panose[i] || 0);
  w8(1);                      // Charset: DEFAULT_CHARSET
  w8(info.italic ? 1 : 0);
  w32(info.weight);
  w16(info.fsType);
  w16(0x504c);                // MagicNumber
  info.unicodeRange.forEach(w32);
  info.codePageRange.forEach(w32);
  w32(info.checkSumAdjustment);
  w32(0); w32(0); w32(0); w32(0); // Reserved1-4
  w16(0); wstr(fam);
  w16(0); wstr(sty);
  w16(0); wstr(ver);
  w16(0); wstr(full);
  w16(0); w16(0);             // Padding5, RootStringSize = 0
  w32(0x50475342);            // RootStringCheckSum (empty root string)
  w32(0);                     // EUDCCodePage
  w16(0); w16(0);             // Padding6, SignatureSize = 0
  w32(0); w32(0);             // EUDCFlags, EUDCFontSize = 0
  out.set(font, o);
  return out;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");

export class FontLibrary {
  constructor() {
    this.fonts = [];
    this.used = new Set();
  }

  // Adds a font file; returns parsed info (throws on unusable fonts).
  add(bytes, fileName = "") {
    const info = parseFont(bytes);
    info.fileName = fileName;
    this.fonts = this.fonts.filter((f) => !(norm(f.fullName) === norm(info.fullName) && f.italic === info.italic));
    this.fonts.push(info);
    return info;
  }

  // Best file for a Figma (family, weight, italic) – exact family, closest weight, same slant.
  find(family, weight = 400, italic = false) {
    const fam = norm(family);
    const cands = this.fonts.filter((f) => norm(f.family) === fam || norm(f.legacyFamily) === fam);
    if (!cands.length) return null;
    let best = null, bestScore = Infinity;
    for (const f of cands) {
      const score = Math.abs(f.weight - weight) + (f.italic === !!italic ? 0 : 1000);
      if (score < bestScore) { best = f; bestScore = score; }
    }
    return bestScore < 1000 && Math.abs(best.weight - weight) <= 50 ? best : null;
  }

  // Run attributes for PowerPoint: typeface name + bold/italic flags selecting the embedded slot.
  resolve(family, weight, italic) {
    const f = this.find(family, weight, italic);
    if (!f) return null;
    this.used.add(f);
    const sub = norm(f.subfamily);
    return {
      typeface: f.legacyFamily,
      bold: sub.includes("bold"),
      italic: sub.includes("italic") || sub.includes("oblique"),
      ascender: f.ascender / f.unitsPerEm,
      descender: -f.descender / f.unitsPerEm,
    };
  }

  // Grouped by typeface for <p:embeddedFontLst>.
  embedded() {
    const groups = new Map();
    for (const f of this.used) {
      const sub = norm(f.subfamily);
      const slot = sub.includes("bold") ? (sub.includes("italic") ? "boldItalic" : "bold") : (sub.includes("italic") ? "italic" : "regular");
      if (!groups.has(f.legacyFamily)) groups.set(f.legacyFamily, { typeface: f.legacyFamily, panose: f.panose, slots: {} });
      groups.get(f.legacyFamily).slots[slot] = makeEot(f);
    }
    return [...groups.values()];
  }
}
