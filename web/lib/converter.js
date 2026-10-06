// Figma node tree -> slide XML parts (packaging is done in pptx.js).
import * as g from "./geometry.js";
import { imageInfo } from "./png.js";
import { EMU_PER_PX, effectsXml, fillXml, lineXml, visiblePaints } from "./paint.js";
import { textBodyXml, textLayout } from "./text.js";

const CONTAINER_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "SLIDE", "GROUP",
  "SLIDE_ROW", "SLIDE_GRID", "INTERACTIVE_SLIDE_ELEMENT"]);
const FRAME_LIKE = new Set([...CONTAINER_TYPES].filter((t) => t !== "GROUP"));
const VECTOR_TYPES = new Set(["VECTOR", "STAR", "REGULAR_POLYGON", "POLYGON", "BOOLEAN_OPERATION", "ELLIPSE", "WASHI_TAPE", "HIGHLIGHT"]);
const KNOWN_TYPES = new Set([...CONTAINER_TYPES, ...VECTOR_TYPES, "RECTANGLE", "TEXT", "LINE"]);

export const DEFAULT_OPTIONS = {
  slideWidthIn: null,        // null = Figma size 1:1 (1 px = 1/96 in)
  rasterizeGradients: false, // gradients as exact PNG picture fills
  fontWeights: "bold",       // "bold" | "names"
  rasterFallback: true,      // masks/unknown nodes rendered as PNG via the Figma API
  fidelity: true,            // also render blurs and clipped overflowing frames as PNG (1:1 look)
  slideImages: false,        // every slide = one exact picture (not editable)
  fonts: null,               // FontLibrary with font files to embed
  lang: "cs-CZ",
};

const RT_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const RT_LINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function nodeSize(node) {
  if (node.size) return [+node.size.x || 0, +node.size.y || 0];
  const bb = node.absoluteBoundingBox || {};
  return [+bb.width || 0, +bb.height || 0];
}

function radiiOf(node) {
  const r = node.rectangleCornerRadii;
  if (r && r.length === 4) return r.map(Number);
  const c = +node.cornerRadius || 0;
  return [c, c, c, c];
}

function fullEllipse(node) {
  const a = node.arcData;
  if (!a) return true;
  const s = a.startingAngle ?? 0, e = a.endingAngle ?? 2 * Math.PI;
  return (a.innerRadius ?? 0) === 0 && Math.abs(e - s - 2 * Math.PI) < 1e-3;
}

function invert(m) {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1e-12;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}

// True when a visible descendant sticks out of the node's own box.
function overflows(node) {
  const bb = node.absoluteBoundingBox;
  if (!bb) return false;
  const eps = 0.5;
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.visible === false) continue;
      const r = c.absoluteRenderBounds || c.absoluteBoundingBox;
      if (r && (r.x < bb.x - eps || r.y < bb.y - eps || r.x + r.width > bb.x + bb.width + eps ||
          r.y + r.height > bb.y + bb.height + eps)) return true;
      if (walk(c)) return true;
    }
    return false;
  };
  return walk(node);
}

function hashBytes(u8) {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(u8.length / 4096));
  for (let i = 0; i < u8.length; i += step) h = Math.imul(h ^ u8[i], 0x01000193);
  return `${u8.length}-${(h >>> 0).toString(16)}`;
}

class El {
  constructor(xml, bounds) { this.xml = xml; this.bounds = bounds; }
}

// Media shared by the whole presentation; relationships are per slide.
class Media {
  constructor() { this.byKey = new Map(); this.files = []; this.jobs = []; }
  addCropped(data, ref, crop, boxW, boxH) {
    const r = (v) => Math.round(v * 10000) / 10000;
    const key = `${ref || hashBytes(data)}|${r(crop.l)},${r(crop.t)},${r(crop.r)},${r(crop.b)}|${r(boxW / boxH)}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    const src = imageInfo(data);
    const inside = crop.l >= -1e-6 && crop.t >= -1e-6 && crop.r >= -1e-6 && crop.b >= -1e-6;
    const ext = src && src.ext === "jpeg" && inside ? "jpeg" : "png";
    const name = `image${this.files.length + 1}.${ext}`;
    const file = { name, data, ext };
    this.files.push(file);
    this.jobs.push({ file, data, crop, boxW, boxH, ext });
    this.byKey.set(key, name);
    return name;
  }
  add(data, key) {
    key = key || hashBytes(data);
    if (this.byKey.has(key)) return this.byKey.get(key);
    const ext = (imageInfo(data) || { ext: "png" }).ext;
    const name = `image${this.files.length + 1}.${ext}`;
    this.files.push({ name, data, ext });
    this.byKey.set(key, name);
    return name;
  }
}

export class Converter {
  constructor(assets, options = {}) {
    this.assets = assets;
    this.opt = { ...DEFAULT_OPTIONS, ...options };
    this.warnings = [];
    this.lang = this.opt.lang;
    this.fontWeights = this.opt.fontWeights;
    this.images = new Map();
    this.rendered = new Map();
  }

  // ---------------------------------------------------------------- public
  async convert(slideNodes, onProgress = () => {}) {
    if (!slideNodes.length) throw new Error("Nebyly nalezeny žádné snímky / rámce k převodu.");
    let [fw, fh] = nodeSize(slideNodes[0]);
    fw = fw || 1920; fh = fh || 1080;
    let scale = 1;
    if (this.opt.slideWidthIn) scale = (this.opt.slideWidthIn * 914400) / (fw * EMU_PER_PX);
    const maxSide = 51206400; // PowerPoint limit: 56 in
    if (Math.max(fw, fh) * EMU_PER_PX * scale > maxSide) scale = maxSide / (Math.max(fw, fh) * EMU_PER_PX);
    this.media = new Media();
    this.ctx = { emu: EMU_PER_PX * scale, rasterizeGradients: this.opt.rasterizeGradients, embed: (d, k) => this.embed(d, k) };
    if (this.assets.cropImage) this.ctx.embedCropped = (d, ref, crop, bw, bh) => this.rid(this.media.addCropped(d, ref, crop, bw, bh));
    this.fonts = this.opt.fonts;
    this.missingFonts = new Set();

    // Pre-fetch every image fill and raster fallback (all network I/O happens here).
    const refs = new Set();
    for (const s of slideNodes) this.collectImageRefs(s, refs);
    let done = 0;
    for (const ref of refs) {
      onProgress(`Stahuji obrázky ${++done}/${refs.size}`);
      try {
        const data = await this.assets.imageFill(ref);
        if (data) this.images.set(ref, data);
        else this.warnings.push(`Obrázek ${ref} se nepodařilo stáhnout.`);
      } catch (e) {
        this.warnings.push(`Obrázek ${ref} se nepodařilo stáhnout (${e.message}).`);
      }
    }
    if (this.opt.rasterFallback && this.assets.canRender?.()) {
      const ids = [];
      for (const s of slideNodes) this.collectRaster(s, ids, true);
      if (ids.length) {
        onProgress(`Vykresluji ${ids.length} prvků jako obrázek`);
        try { this.rendered = await this.assets.renderNodes(ids); }
        catch (e) { this.warnings.push(`Vykreslení prvků selhalo: ${e.message}`); }
      }
    }

    const slides = slideNodes.map((node, i) => {
      onProgress(`Převádím snímek ${i + 1}/${slideNodes.length}`);
      return this.convertSlide(node);
    });
    let k = 0;
    for (const job of this.media.jobs) {
      onProgress(`Ořezávám obrázky ${++k}/${this.media.jobs.length}`);
      try { job.file.data = await this.assets.cropImage(job); }
      catch (e) { this.warnings.push(`Obrázek se nepodařilo oříznout (${e.message}).`); }
    }
    return {
      widthEmu: Math.round(fw * this.ctx.emu),
      heightEmu: Math.round(fh * this.ctx.emu),
      slides,
      media: this.media.files,
      fonts: this.fonts ? this.fonts.embedded() : [],
      missingFonts: [...this.missingFonts].map((k) => { const [family, weight, italic] = k.split("|"); return { family, weight: +weight, italic: italic === "1" }; }),
      warnings: [...new Set(this.warnings)],
    };
  }

  // ---------------------------------------------------------------- pre-pass
  collectImageRefs(node, refs) {
    if (node.visible === false) return;
    for (const p of [...(node.fills || []), ...(node.strokes || [])]) {
      if (p.type === "IMAGE" && p.visible !== false && (p.imageRef || p.gifRef)) refs.add(p.imageRef || p.gifRef);
    }
    for (const c of node.children || []) this.collectImageRefs(c, refs);
  }

  needsRaster(node) {
    const t = node.type;
    if (!KNOWN_TYPES.has(t)) return true;
    if ((CONTAINER_TYPES.has(t) || t === "BOOLEAN_OPERATION") &&
        (node.children || []).some((c) => c.isMask && c.visible !== false)) return true;
    if (!this.opt.fidelity) return false;
    // Effects PPTX cannot draw: layer/background blur.
    if ((node.effects || []).some((e) => e.visible !== false && /BLUR/.test(e.type || ""))) return true;
    // Frames that clip children sticking out of them (PPTX has no clipping).
    if (FRAME_LIKE.has(t) && node.clipsContent && overflows(node)) return true;
    return false;
  }

  collectRaster(node, ids, isRoot = false) {
    if (node.visible === false) return;
    if (isRoot && this.opt.slideImages) { ids.push(node.id); return; }
    if (!isRoot && this.needsRaster(node)) { ids.push(node.id); return; }
    if (node.type === "BOOLEAN_OPERATION") return;
    for (const c of node.children || []) this.collectRaster(c, ids);
  }

  // ---------------------------------------------------------------- slide parts
  embed(data, key) {
    return this.rid(this.media.add(data, key));
  }

  rid(name) {
    const s = this.slideState;
    if (!s.mediaRids.has(name)) {
      const rId = `rId${s.rels.length + 1}`;
      s.rels.push({ id: rId, type: RT_IMAGE, target: `../media/${name}` });
      s.mediaRids.set(name, rId);
    }
    return s.mediaRids.get(name);
  }

  hyperlink(url) {
    const s = this.slideState;
    const rId = `rId${s.rels.length + 1}`;
    s.rels.push({ id: rId, type: RT_LINK, target: url, external: true });
    return rId;
  }

  nextId() { return ++this.slideState.id; }

  xfrm(pl) {
    const e = this.ctx.emu;
    let attrs = "";
    if (pl.rot) attrs += ` rot="${Math.round(pl.rot * 60000) % 21600000}"`;
    if (pl.flipH) attrs += ' flipH="1"';
    return `<a:xfrm${attrs}><a:off x="${Math.round(pl.x * e)}" y="${Math.round(pl.y * e)}"/>` +
      `<a:ext cx="${Math.max(0, Math.round(pl.w * e))}" cy="${Math.max(0, Math.round(pl.h * e))}"/></a:xfrm>`;
  }

  sp(name, pl, geom, fill, ln = null, effects = "", txbody = null, txbox = false) {
    const id = this.nextId();
    const cnv = txbox ? '<p:cNvSpPr txBox="1"/>' : "<p:cNvSpPr/>";
    const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${g.esc(name)}"/>${cnv}<p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${this.xfrm(pl)}${geom}${fill || "<a:noFill/>"}${ln || "<a:ln><a:noFill/></a:ln>"}${effects}</p:spPr>` +
      `${txbody || ""}</p:sp>`;
    return new El(xml, pl.bounds());
  }

  pic(name, pl, rId, { blip = null, geom = g.prstGeomXml("rect"), ln = "", effects = "" } = {}) {
    const id = this.nextId();
    const fill = blip ? blip.replace(/^<a:blipFill/, "<p:blipFill").replace(/<\/a:blipFill>$/, "</p:blipFill>")
      : `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
    const xml = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${g.esc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `${fill}<p:spPr>${this.xfrm(pl)}${geom}${ln}${effects}</p:spPr></p:pic>`;
    return new El(xml, pl.bounds());
  }

  grp(name, els) {
    els = els.filter(Boolean);
    if (!els.length) return null;
    if (els.length === 1) return els[0];
    const x0 = Math.min(...els.map((e) => e.bounds[0])), y0 = Math.min(...els.map((e) => e.bounds[1]));
    const x1 = Math.max(...els.map((e) => e.bounds[0] + e.bounds[2])), y1 = Math.max(...els.map((e) => e.bounds[1] + e.bounds[3]));
    const e = this.ctx.emu;
    const off = `x="${Math.round(x0 * e)}" y="${Math.round(y0 * e)}"`;
    const ext = `cx="${Math.round((x1 - x0) * e)}" cy="${Math.round((y1 - y0) * e)}"`;
    const id = this.nextId();
    const xml = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${g.esc(name)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off ${off}/><a:ext ${ext}/><a:chOff ${off}/><a:chExt ${ext}/></a:xfrm></p:grpSpPr>` +
      `${els.map((x) => x.xml).join("")}</p:grpSp>`;
    return new El(xml, [x0, y0, x1 - x0, y1 - y0]);
  }

  imageBytes(paint) {
    if (paint.type !== "IMAGE") return null;
    return this.images.get(paint.imageRef || paint.gifRef) || null;
  }

  // ---------------------------------------------------------------- transforms
  transform(node, parentM, containerM) {
    if (node.absoluteTransform && this.rootInv) return g.mul(this.rootInv, g.mat(node.absoluteTransform));
    const rel = node.relativeTransform;
    const [w, h] = nodeSize(node);
    const bb = node.absoluteBoundingBox;
    const target = bb ? [bb.x - this.origin[0], bb.y - this.origin[1], bb.width, bb.height] : null;
    if (!rel) return target ? g.translate(target[0], target[1]) : parentM;
    const r = g.mat(rel);
    const cands = [g.mul(containerM, r)];
    if (parentM !== containerM) cands.push(g.mul(parentM, r));
    if (!target || cands.length === 1) return cands[0];
    const err = (m) => g.aabb(m, 0, 0, w, h).reduce((s, v, i) => s + Math.abs(v - target[i]), 0);
    return cands.reduce((best, m) => (err(m) < err(best) ? m : best));
  }

  // ---------------------------------------------------------------- slides
  convertSlide(root) {
    this.slideState = { id: 1, rels: [{ id: "rId1", type: "layout" }], mediaRids: new Map() };
    const bb = root.absoluteBoundingBox || { x: 0, y: 0 };
    this.origin = [+bb.x || 0, +bb.y || 0];
    const [w, h] = nodeSize(root);
    this.rootInv = root.absoluteTransform ? invert(g.mat(root.absoluteTransform)) : null;
    if (this.opt.slideImages && this.rendered.has(root.id)) {
      const el = this.pic(root.name || "Snímek", new g.Placement(0, 0, w, h), this.embed(this.rendered.get(root.id), `render:${root.id}`));
      return { name: root.name || "", bgXml: "", shapesXml: el.xml, rels: this.slideState.rels };
    }
    let rootM = g.IDENTITY;
    if (root.relativeTransform && !FRAME_LIKE.has(root.type)) {
      const m = g.mat(root.relativeTransform);
      const [bx, by] = g.aabb([[m[0][0], m[0][1], 0], [m[1][0], m[1][1], 0]], 0, 0, w, h);
      rootM = [[m[0][0], m[0][1], -bx], [m[1][0], m[1][1], -by]];
    }
    const els = [];
    const opacity = root.opacity ?? 1;
    let bgXml = "";
    let containerM;
    if (FRAME_LIKE.has(root.type)) {
      let fills = visiblePaints(root.fills);
      if (fills.length && !radiiOf(root).some(Boolean)) {
        const bg = fillXml(fills[0], this.ctx, w, h, [0, 0, w, h], opacity, this.imageBytes(fills[0]));
        if (bg) { bgXml = `<p:bg><p:bgPr>${bg}<a:effectLst/></p:bgPr></p:bg>`; fills = fills.slice(1); }
      }
      fills.forEach((p, i) => {
        const fx = fillXml(p, this.ctx, w, h, [0, 0, w, h], opacity, this.imageBytes(p));
        if (fx) els.push(this.sp(`${root.name || "Pozadí"} – pozadí ${i + 1}`, new g.Placement(0, 0, w, h), g.prstGeomXml("rect"), fx));
      });
      containerM = rootM;
    } else {
      containerM = g.translate(-this.origin[0], -this.origin[1]);
    }
    for (const c of root.children || []) {
      const el = this.node(c, rootM, containerM, opacity);
      if (el) els.push(el);
    }
    return { name: root.name || "", bgXml, shapesXml: els.map((e) => e.xml).join(""), rels: this.slideState.rels };
  }

  // ---------------------------------------------------------------- nodes
  node(node, parentM, containerM, opacity) {
    if (node.visible === false || node.isMask) return null;
    const t = node.type;
    const m = this.transform(node, parentM, containerM);
    const op = opacity * (node.opacity ?? 1);
    const name = node.name || t || "Tvar";

    if (this.rendered.has(node.id)) return this.raster(node, name);
    if (this.needsRaster(node)) {
      if (!KNOWN_TYPES.has(t)) { this.warnings.push(`Nepodporovaný typ uzlu ${t} („${name}“) byl vynechán.`); return null; }
      this.warnings.push(`Maska v „${name}“ není v PPTX podporovaná – vykresleno bez masky.`);
    }
    if (CONTAINER_TYPES.has(t)) {
      const els = FRAME_LIKE.has(t) ? this.boxLayers(node, m, op, name, "rect") : [];
      const childContainer = t !== "GROUP" ? m : containerM;
      for (const c of node.children || []) {
        const el = this.node(c, m, childContainer, op);
        if (el) els.push(el);
      }
      return this.grp(name, els);
    }
    if (t === "RECTANGLE") return this.grp(name, this.boxLayers(node, m, op, name, "rect"));
    if (t === "ELLIPSE" && fullEllipse(node)) return this.grp(name, this.boxLayers(node, m, op, name, "ellipse"));
    if (t === "TEXT") return this.text(node, m, op, name);
    if (t === "LINE") return this.line(node, m, op, name);
    if (VECTOR_TYPES.has(t)) return this.grp(name, this.vectorLayers(node, m, op, name));
    return null;
  }

  raster(node, name) {
    const data = this.rendered.get(node.id);
    const bb = node.rasterBounds || node.absoluteBoundingBox;
    if (!data || !bb) return null;
    const pl = new g.Placement(bb.x - this.origin[0], bb.y - this.origin[1], bb.width, bb.height);
    return this.pic(`${name} (obrázek)`, pl, this.embed(data, `render:${node.id}`));
  }

  boxLayers(node, m, op, name, kind) {
    const [w, h] = nodeSize(node);
    const fills = visiblePaints(node.fills);
    let strokes = visiblePaints(node.strokes);
    let sw = +node.strokeWeight || 0;
    if (!strokes.length || sw <= 0) strokes = [];
    const effects = effectsXml(node, this.ctx, op);
    if (!fills.length && !strokes.length && !effects) return [];
    if (strokes.length && node.individualStrokeWeights) {
      const iw = node.individualStrokeWeights;
      this.warnings.push(`„${name}“: rozdílné tloušťky okrajů nejsou v PPTX podporované.`);
      sw = Math.max(...["top", "right", "bottom", "left"].map((k) => +iw[k] || 0));
    }
    const radii = radiiOf(node);
    const geom = (d) => {
      if (kind === "ellipse") return g.prstGeomXml("ellipse");
      const r = radii.map((v) => (v > 0 ? Math.max(0, v + d) : 0));
      const bw = w + 2 * d, bh = h + 2 * d;
      if (!r.some(Boolean)) return g.prstGeomXml("rect");
      if (Math.max(...r) - Math.min(...r) < 0.01) {
        return g.prstGeomXml("roundRect", { adj: Math.round(Math.min(50000, (r[0] / Math.max(1e-6, Math.min(bw, bh))) * 100000)) });
      }
      return g.custGeomXml([g.roundedRectPath(bw, bh, r)], 0, 0, bw, bh, this.ctx.emu);
    };
    const align = node.strokeAlign || "CENTER";
    const d = strokes.length ? ({ INSIDE: -sw / 2, OUTSIDE: sw / 2 }[align] || 0) : 0;
    const sp = strokes[strokes.length - 1];
    const opaqueStroke = !!sp && sp.type === "SOLID" && (sp.color?.a ?? 1) * (sp.opacity ?? 1) * op >= 0.999;
    const separateStroke = strokes.length > 0 && d !== 0 && !opaqueStroke;

    // A single image fill becomes a real picture (Change Picture / Crop work in PowerPoint).
    if (fills.length === 1 && fills[0].type === "IMAGE" && (fills[0].scaleMode || "FILL") !== "TILE" &&
        this.imageBytes(fills[0]) && !d) {
      const blip = fillXml(fills[0], this.ctx, w, h, [0, 0, w, h], op, this.imageBytes(fills[0]));
      if (blip) {
        const ln = strokes.length ? lineXml(node, this.ctx, w, h, [0, 0, w, h], op, sw) : "";
        return [this.pic(name, g.place(m, 0, 0, w, h), null, { blip, geom: geom(0), ln, effects })];
      }
    }
    const layers = [];
    let fillXmls = [];
    for (const p of fills) {
      const fx = fillXml(p, this.ctx, w, h, [0, 0, w, h], op, this.imageBytes(p));
      if (fx) fillXmls.push([p, fx]);
    }
    if (!fillXmls.length) fillXmls = strokes.length || effects ? [[null, "<a:noFill/>"]] : [];
    fillXmls.forEach(([p, fx], i) => {
      const top = i === fillXmls.length - 1;
      const lname = i === 0 ? name : `${name} – výplň ${i + 1}`;
      const eff = i === 0 ? effects : "";
      if (top && strokes.length && !separateStroke) {
        const box = [-d, -d, w + 2 * d, h + 2 * d];
        if (p && d) fx = fillXml(p, this.ctx, w, h, box, op, this.imageBytes(p)) || fx;
        const ln = lineXml(node, this.ctx, w, h, box, op, sw);
        layers.push(this.sp(lname, g.place(m, ...box), geom(d), fx, ln, eff));
      } else {
        layers.push(this.sp(lname, g.place(m, 0, 0, w, h), geom(0), fx, null, eff));
      }
    });
    if (separateStroke) {
      const box = [-d, -d, w + 2 * d, h + 2 * d];
      layers.push(this.sp(`${name} – okraj`, g.place(m, ...box), geom(d), null, lineXml(node, this.ctx, w, h, box, op, sw)));
    }
    return layers;
  }

  vectorLayers(node, m, op, name) {
    const [w, h] = nodeSize(node);
    const fills = visiblePaints(node.fills);
    const strokes = visiblePaints(node.strokes);
    const sw = +node.strokeWeight || 0;
    const effects = effectsXml(node, this.ctx, op);
    const fillPaths = (node.fillGeometry || []).map((p) => g.parseSvgPath(p.path)).filter((p) => p.length);
    const strokePaths = (node.strokeGeometry || []).map((p) => g.parseSvgPath(p.path)).filter((p) => p.length);
    const layers = [];
    const boxFor = (paths) => {
      const bb = g.segmentsBbox(paths);
      let x0 = 0, y0 = 0, x1 = w, y1 = h;
      if (bb) { x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]); x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]); }
      return [x0, y0, Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3)];
    };
    if (fillPaths.length && fills.length) {
      const box = boxFor(fillPaths);
      const geom = g.custGeomXml(fillPaths, ...box, this.ctx.emu);
      const fxs = fills.map((p) => fillXml(p, this.ctx, w, h, box, op, this.imageBytes(p))).filter(Boolean);
      fxs.forEach((fx, i) => {
        const ln = i === fxs.length - 1 && strokes.length && sw > 0 && !strokePaths.length ? lineXml(node, this.ctx, w, h, box, op, sw) : null;
        layers.push(this.sp(i === 0 ? name : `${name} – výplň ${i + 1}`, g.place(m, ...box), geom, fx, ln, i === 0 ? effects : ""));
      });
    }
    if (strokes.length && sw > 0) {
      if (strokePaths.length) {
        const box = boxFor(strokePaths);
        const geom = g.custGeomXml(strokePaths, ...box, this.ctx.emu);
        strokes.forEach((p, i) => {
          const fx = fillXml(p, this.ctx, w, h, box, op, this.imageBytes(p));
          if (fx) layers.push(this.sp(i === 0 ? `${name} – okraj` : `${name} – okraj ${i + 1}`, g.place(m, ...box), geom, fx, null, layers.length ? "" : effects));
        });
      } else if (!(fillPaths.length && fills.length) && fillPaths.length) {
        const box = boxFor(fillPaths);
        const geom = g.custGeomXml(fillPaths, ...box, this.ctx.emu, { fill: false });
        layers.push(this.sp(name, g.place(m, ...box), geom, null, lineXml(node, this.ctx, w, h, box, op, sw), effects));
      }
    }
    if (!layers.length && !fillPaths.length && !strokePaths.length && (fills.length || strokes.length)) {
      this.warnings.push(`„${name}“: chybí geometrie vektoru.`);
    }
    return layers;
  }

  line(node, m, op, name) {
    const [w] = nodeSize(node);
    if (!visiblePaints(node.strokes).length) return null;
    const pl = g.place(m, 0, 0, w, 0);
    return this.sp(name, pl, g.prstGeomXml("line"), null, lineXml(node, this.ctx, w, 1, [0, 0, w, 1], op), effectsXml(node, this.ctx, op));
  }

  text(node, m, op, name) {
    if (!node.characters) return null;
    const [w, h] = nodeSize(node);
    const lay = textLayout(node, this);
    // Wrapped text gets width slack (other font renderers are a bit wider), kept on the alignment side.
    const align = (node.style || {}).textAlignHorizontal;
    const x0 = align === "RIGHT" ? -lay.slack : align === "CENTER" ? -lay.slack / 2 : 0;
    const pl = g.place(m, x0, -lay.shift, w + lay.slack, h);
    return this.sp(name, pl, g.prstGeomXml("rect"), null, null, "", textBodyXml(node, this, op, w, h, lay), true);
  }
}
