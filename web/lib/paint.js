// Figma paints/effects -> DrawingML fill, line and effect XML.
import { encodePng, imageInfo } from "./png.js";

export const EMU_PER_PX = 9525; // 96 dpi

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const pct = (v) => Math.round(v * 100000);

export function hexRgb(c) {
  return ["r", "g", "b"]
    .map((k) => Math.max(0, Math.min(255, Math.round((+c[k] || 0) * 255))).toString(16).padStart(2, "0"))
    .join("").toUpperCase();
}

export function colorXml(c, alpha = 1) {
  const a = clamp01((c.a ?? 1) * alpha);
  if (a >= 0.99999) return `<a:srgbClr val="${hexRgb(c)}"/>`;
  return `<a:srgbClr val="${hexRgb(c)}"><a:alpha val="${Math.round(a * 100000)}"/></a:srgbClr>`;
}

export function visiblePaints(paints) {
  return (paints || []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);
}

function stopsOf(paint) {
  const s = (paint.gradientStops || []).map((g) => [+g.position || 0, [g.color.r ?? 0, g.color.g ?? 0, g.color.b ?? 0, g.color.a ?? 1]]);
  s.sort((a, b) => a[0] - b[0]);
  return s.length ? s : [[0, [0, 0, 0, 1]], [1, [0, 0, 0, 1]]];
}

function colorAt(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    if (p0 <= t && t <= p1) {
      const f = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return c0.map((v, k) => v + (c1[k] - v) * f);
    }
  }
  return stops[stops.length - 1][1];
}

const toC = (c) => ({ r: c[0], g: c[1], b: c[2], a: c[3] });
const gs = (pos, c, alpha) => `<a:gs pos="${pct(clamp01(pos))}">${colorXml(toC(c), alpha)}</a:gs>`;

// Map Figma gradient parameter range [t0, t1] onto DrawingML 0..1.
function remapStops(stops, t0, t1, alpha) {
  const span = t1 - t0;
  if (Math.abs(span) < 1e-9) return gs(0, colorAt(stops, t0), alpha) + gs(1, colorAt(stops, t0), alpha);
  const pts = [[0, colorAt(stops, t0)]];
  for (const [p, c] of stops) {
    const u = (p - t0) / span;
    if (u > 0 && u < 1) pts.push([u, c]);
  }
  pts.push([1, colorAt(stops, t1)]);
  pts.sort((a, b) => a[0] - b[0]);
  return pts.map(([u, c]) => gs(u, c, alpha)).join("");
}

function handlesPx(paint, nw, nh, box) {
  const [bx, by] = box;
  let hs = paint.gradientHandlePositions || [];
  if (hs.length < 3) hs = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }];
  return hs.slice(0, 3).map((h) => [h.x * nw - bx, h.y * nh - by]);
}

export function linearGradientXml(paint, nw, nh, box, alpha) {
  const [, , bw, bh] = box;
  const stops = stopsOf(paint);
  const [[sx, sy], [ex, ey], [wx, wy]] = handlesPx(paint, nw, nh, box);
  const ux = ex - sx, uy = ey - sy, vx = wx - sx, vy = wy - sy;
  const det = ux * vy - uy * vx;
  if (ux * ux + uy * uy < 1e-9) return `<a:solidFill>${colorXml(toC(stops[0][1]), alpha)}</a:solidFill>`;
  const corners = [[0, 0], [bw, 0], [0, bh], [bw, bh]];
  let ts, nx, ny;
  if (Math.abs(det) > 1e-9) {
    // Figma's parameter = first coordinate of the inverse handle affine; iso-lines run
    // along the width handle, so the DrawingML direction is that handle's normal.
    ts = corners.map(([cx, cy]) => ((cx - sx) * vy - (cy - sy) * vx) / det);
    nx = vy; ny = -vx;
    if (nx * ux + ny * uy < 0) { nx = -nx; ny = -ny; }
  } else {
    const l2 = ux * ux + uy * uy;
    ts = corners.map(([cx, cy]) => ((cx - sx) * ux + (cy - sy) * uy) / l2);
    nx = ux; ny = uy;
  }
  const ang = (((Math.atan2(ny, nx) * 180) / Math.PI) % 360 + 360) % 360;
  const g = remapStops(stops, Math.min(...ts), Math.max(...ts), alpha);
  return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${g}</a:gsLst><a:lin ang="${Math.round(ang * 60000) % 21600000}" scaled="0"/></a:gradFill>`;
}

export function radialGradientXml(paint, nw, nh, box, alpha) {
  let [, , bw, bh] = box;
  const stops = stopsOf(paint);
  const [[cx, cy], [ex, ey], [wx, wy]] = handlesPx(paint, nw, nh, box);
  bw = bw || 1; bh = bh || 1;
  const fx = cx / bw, fy = cy / bh;
  const r1 = Math.hypot((ex - cx) / bw, (ey - cy) / bh);
  const r2 = Math.hypot((wx - cx) / bw, (wy - cy) / bh);
  const rFig = r2 ? (r1 + r2) / 2 : r1;
  // DrawingML "circle" path: the outer edge reaches the farthest box corner.
  const rPpt = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Math.hypot(fx - x, fy - y)));
  const t1 = rFig > 1e-9 ? rPpt / rFig : 1;
  const g = remapStops(stops, 0, t1, alpha);
  return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${g}</a:gsLst><a:path path="circle">` +
    `<a:fillToRect l="${Math.trunc(fx * 100000)}" t="${Math.trunc(fy * 100000)}" r="${Math.trunc((1 - fx) * 100000)}" b="${Math.trunc((1 - fy) * 100000)}"/>` +
    `</a:path><a:tileRect/></a:gradFill>`;
}

// Exact raster of any Figma gradient (angular/diamond, or on demand).
export function renderGradientPng(paint, nw, nh, box, maxPx = 1600) {
  const bw = Math.max(box[2], 1e-3), bh = Math.max(box[3], 1e-3);
  const scale = Math.min(2, maxPx / Math.max(bw, bh));
  const W = Math.max(4, Math.ceil(bw * scale)), H = Math.max(4, Math.ceil(bh * scale));
  const [[x0, y0], [x1, y1], [x2, y2]] = handlesPx(paint, nw, nh, box);
  const ux = x1 - x0, uy = y1 - y0, vx = x2 - x0, vy = y2 - y0;
  const det = ux * vy - uy * vx;
  const l2 = ux * ux + uy * uy || 1;
  const stops = stopsOf(paint);
  const kind = paint.type;
  const op = paint.opacity ?? 1;
  const out = new Uint8Array(W * H * 4);
  // Lookup table for speed.
  const LUT = 1024;
  const lut = new Float32Array((LUT + 1) * 4);
  const tMin = kind === "GRADIENT_ANGULAR" ? 0 : Math.min(0, stops[0][0]);
  const tMax = kind === "GRADIENT_ANGULAR" ? 1 : Math.max(1, stops[stops.length - 1][0]);
  for (let i = 0; i <= LUT; i++) {
    const c = colorAt(stops, tMin + ((tMax - tMin) * i) / LUT);
    lut.set(c, i * 4);
  }
  for (let y = 0; y < H; y++) {
    const py = ((y + 0.5) / H) * bh - y0;
    for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) / W) * bw - x0;
      let gx, gy;
      if (Math.abs(det) < 1e-9) { gx = (px * ux + py * uy) / l2; gy = 0; }
      else { gx = (px * vy - py * vx) / det; gy = (ux * py - uy * px) / det; }
      let t;
      if (kind === "GRADIENT_LINEAR") t = gx;
      else if (kind === "GRADIENT_RADIAL") t = Math.hypot(gx, gy);
      else if (kind === "GRADIENT_ANGULAR") t = ((Math.atan2(gy, gx) / (2 * Math.PI)) % 1 + 1) % 1;
      else t = Math.abs(gx) + Math.abs(gy);
      const idx = Math.round((Math.max(tMin, Math.min(tMax, t)) - tMin) / (tMax - tMin) * LUT) * 4;
      const o = (y * W + x) * 4;
      out[o] = Math.round(lut[idx] * 255);
      out[o + 1] = Math.round(lut[idx + 1] * 255);
      out[o + 2] = Math.round(lut[idx + 2] * 255);
      out[o + 3] = Math.round(lut[idx + 3] * op * 255);
    }
  }
  return encodePng(out, W, H);
}

function blipFill(rId, alpha, inner = "<a:stretch><a:fillRect/></a:stretch>", src = "") {
  const amt = alpha < 0.99999 ? `<a:alphaModFix amt="${Math.round(Math.max(0, alpha) * 100000)}"/>` : "";
  return `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rId}">${amt}</a:blip>${src}${inner}</a:blipFill>`;
}

export function imageFillXml(paint, data, ctx, nw, nh, box, alpha) {
  let [, , bw, bh] = box;
  const info = imageInfo(data) || { width: 1, height: 1 };
  const rId = ctx.embed(data, paint.imageRef);
  const mode = paint.scaleMode || "FILL";
  bw = bw || 1; bh = bh || 1;
  const ia = info.height ? info.width / info.height : 1, ba = bw / bh;
  if (mode === "FIT") {
    if (ia > ba) { const p = (1 - ba / ia) / 2; return blipFill(rId, alpha, `<a:stretch><a:fillRect t="${pct(p)}" b="${pct(p)}"/></a:stretch>`); }
    const p = (1 - ia / ba) / 2;
    return blipFill(rId, alpha, `<a:stretch><a:fillRect l="${pct(p)}" r="${pct(p)}"/></a:stretch>`);
  }
  if (mode === "TILE") {
    const s = pct((paint.scalingFactor || 1) * ctx.emu / EMU_PER_PX);
    return blipFill(rId, alpha, `<a:tile tx="0" ty="0" sx="${s}" sy="${s}" flip="none" algn="tl"/>`);
  }
  if (mode === "CROP" && paint.imageTransform) {
    const m = paint.imageTransform;
    const x0 = +m[0][2], y0 = +m[1][2], sw = +m[0][0] || 1, sh = +m[1][1] || 1;
    return blipFill(rId, alpha, undefined, `<a:srcRect l="${pct(x0)}" t="${pct(y0)}" r="${pct(1 - x0 - sw)}" b="${pct(1 - y0 - sh)}"/>`);
  }
  if (ia > ba) { const c = (1 - ba / ia) / 2; return blipFill(rId, alpha, undefined, `<a:srcRect l="${pct(c)}" r="${pct(c)}"/>`); }
  const c = (1 - ia / ba) / 2;
  return blipFill(rId, alpha, undefined, `<a:srcRect t="${pct(c)}" b="${pct(c)}"/>`);
}

// One Figma paint -> one DrawingML fill element (or null).
export function fillXml(paint, ctx, nw, nh, box, opacity, imageBytes = null, allowRaster = true) {
  const alpha = (paint.opacity ?? 1) * opacity;
  const kind = paint.type || "";
  if (kind === "SOLID") return `<a:solidFill>${colorXml(paint.color || {}, alpha)}</a:solidFill>`;
  if (kind.startsWith("GRADIENT_")) {
    const native = ["GRADIENT_LINEAR", "GRADIENT_RADIAL"].includes(kind) && (!ctx.rasterizeGradients || !allowRaster);
    if (native && kind === "GRADIENT_LINEAR") return linearGradientXml(paint, nw, nh, box, alpha);
    if (native && kind === "GRADIENT_RADIAL") return radialGradientXml(paint, nw, nh, box, alpha);
    if (!allowRaster) return radialGradientXml({ ...paint, type: "GRADIENT_RADIAL" }, nw, nh, box, alpha);
    const png = renderGradientPng({ ...paint, opacity: 1 }, nw, nh, box);
    return blipFill(ctx.embed(png), alpha);
  }
  if (kind === "IMAGE" && imageBytes) return imageFillXml(paint, imageBytes, ctx, nw, nh, box, alpha);
  return null;
}

// ------------------------------------------------------------------ strokes
const CAP = { ROUND: "rnd", SQUARE: "sq" };

export function lineXml(node, ctx, nw, nh, box, opacity, weight = null) {
  const strokes = visiblePaints(node.strokes);
  const w = weight ?? (node.strokeWeight ?? 1);
  const paint = strokes[strokes.length - 1];
  if (!paint || w <= 0) return "<a:ln><a:noFill/></a:ln>";
  let fill = fillXml(paint, ctx, nw, nh, box, opacity, null, false) || "<a:noFill/>";
  if (paint.type === "IMAGE") fill = `<a:solidFill>${colorXml({ r: 0.5, g: 0.5, b: 0.5 }, opacity)}</a:solidFill>`;
  const cap = CAP[node.strokeCap] || "flat";
  let dash = "";
  let dashes = node.strokeDashes || [];
  if (dashes.length) {
    if (dashes.length % 2) dashes = dashes.concat(dashes);
    let ds = "";
    for (let i = 0; i < dashes.length; i += 2) ds += `<a:ds d="${Math.round((dashes[i] / w) * 100000)}" sp="${Math.round((dashes[i + 1] / w) * 100000)}"/>`;
    dash = `<a:custDash>${ds}</a:custDash>`;
  }
  const join = { ROUND: "<a:round/>", BEVEL: "<a:bevel/>" }[node.strokeJoin] || '<a:miter lim="800000"/>';
  return `<a:ln w="${Math.round(w * ctx.emu)}" cap="${cap}">${fill}${dash}${join}</a:ln>`;
}

// ------------------------------------------------------------------ effects
export function effectsXml(node, ctx, opacity = 1) {
  let outer = "", inner = "";
  for (const e of node.effects || []) {
    if (e.visible === false || !["DROP_SHADOW", "INNER_SHADOW"].includes(e.type)) continue;
    const ox = e.offset?.x || 0, oy = e.offset?.y || 0;
    const dist = Math.round(Math.hypot(ox, oy) * ctx.emu);
    const dir = Math.round(((((Math.atan2(oy, ox) * 180) / Math.PI) % 360 + 360) % 360) * 60000) % 21600000;
    const blur = Math.round((e.radius || 0) * ctx.emu);
    const col = colorXml(e.color || { r: 0, g: 0, b: 0, a: 0.25 }, opacity);
    if (e.type === "DROP_SHADOW" && !outer) {
      const spread = e.spread || 0;
      const nw = node.size?.x || 0, nh = node.size?.y || 0;
      const sc = spread && nw > 0 && nh > 0
        ? ` sx="${Math.round(((nw + 2 * spread) / nw) * 100000)}" sy="${Math.round(((nh + 2 * spread) / nh) * 100000)}"` : "";
      outer = `<a:outerShdw blurRad="${blur}" dist="${dist}" dir="${dir}"${sc} algn="ctr" rotWithShape="0">${col}</a:outerShdw>`;
    } else if (e.type === "INNER_SHADOW" && !inner) {
      inner = `<a:innerShdw blurRad="${blur}" dist="${dist}" dir="${dir}">${col}</a:innerShdw>`;
    }
  }
  return outer || inner ? `<a:effectLst>${inner}${outer}</a:effectLst>` : "";
}
