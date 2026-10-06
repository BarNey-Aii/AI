// Affine transforms, SVG path parsing and DrawingML geometry builders.
// Matrix: [[a, c, tx], [b, d, ty]] maps (x, y) -> (a x + c y + tx, b x + d y + ty)

export const IDENTITY = [[1, 0, 0], [0, 1, 0]];

export function mat(m) {
  return [[+m[0][0], +m[0][1], +m[0][2]], [+m[1][0], +m[1][1], +m[1][2]]];
}

export function mul(m1, m2) {
  const [[a1, c1, e1], [b1, d1, f1]] = m1;
  const [[a2, c2, e2], [b2, d2, f2]] = m2;
  return [
    [a1 * a2 + c1 * b2, a1 * c2 + c1 * d2, a1 * e2 + c1 * f2 + e1],
    [b1 * a2 + d1 * b2, b1 * c2 + d1 * d2, b1 * e2 + d1 * f2 + f1],
  ];
}

export const translate = (tx, ty) => [[1, 0, tx], [0, 1, ty]];

export function apply(m, x, y) {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

export function aabb(m, x0, y0, w, h) {
  const pts = [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]].map(([x, y]) => apply(m, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const mx = Math.min(...xs), my = Math.min(...ys);
  return [mx, my, Math.max(...xs) - mx, Math.max(...ys) - my];
}

export class Placement {
  constructor(x, y, w, h, rot = 0, flipH = false) {
    Object.assign(this, { x, y, w, h, rot, flipH });
  }
  bounds() {
    if (!this.rot) return [this.x, this.y, this.w, this.h];
    const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
    const r = (this.rot * Math.PI) / 180;
    const m = [[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0]];
    const [bx, by, bw, bh] = aabb(m, -this.w / 2, -this.h / 2, this.w, this.h);
    return [cx + bx, cy + by, bw, bh];
  }
}

// Local box (x0, y0, w, h) under absolute transform m -> DrawingML placement.
export function place(m, x0, y0, w, h) {
  const [cx, cy] = apply(m, x0 + w / 2, y0 + h / 2);
  const a = m[0][0], c = m[0][1], b = m[1][0], d = m[1][1];
  const det = a * d - b * c;
  const flip = det < 0;
  let rot = (flip ? Math.atan2(-b, -a) : Math.atan2(b, a)) * 180 / Math.PI;
  rot = ((rot % 360) + 360) % 360;
  if (Math.abs(rot) < 1e-4 || Math.abs(rot - 360) < 1e-4) rot = 0;
  const sx = Math.hypot(a, b) || 1;
  const sy = sx ? Math.abs(det) / sx : 1;
  const w2 = w * sx, h2 = h * sy;
  return new Placement(cx - w2 / 2, cy - h2 / 2, w2, h2, rot, flip);
}

// ------------------------------------------------------------------ SVG paths
// Segments: ["M", [x, y]], ["L", [x, y]], ["C", [x1, y1, x2, y2, x, y]], ["Q", [x1, y1, x, y]], ["Z", []]

const TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

export function parseSvgPath(d) {
  const tokens = [];
  for (const m of (d || "").matchAll(TOKEN_RE)) tokens.push([m[1], m[2]]);
  const segs = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, last = null;
  const num = () => parseFloat(tokens[i++][1]);
  while (i < tokens.length) {
    if (tokens[i][0]) {
      cmd = tokens[i][0];
      i++;
      if (cmd === "Z" || cmd === "z") {
        segs.push(["Z", []]);
        cx = sx; cy = sy; last = null;
        continue;
      }
    } else if (cmd === null) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === "M") {
      const x = num() + ox, y = num() + oy;
      segs.push(["M", [x, y]]);
      cx = sx = x; cy = sy = y;
      cmd = rel ? "l" : "L"; last = null;
    } else if (C === "L") {
      const x = num() + ox, y = num() + oy;
      segs.push(["L", [x, y]]); cx = x; cy = y; last = null;
    } else if (C === "H") {
      const x = num() + ox; segs.push(["L", [x, cy]]); cx = x; last = null;
    } else if (C === "V") {
      const y = num() + (rel ? cy : 0); segs.push(["L", [cx, y]]); cy = y; last = null;
    } else if (C === "C") {
      const p = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy];
      segs.push(["C", p]); cx = p[4]; cy = p[5]; last = ["C", p[2], p[3]];
    } else if (C === "S") {
      const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
      const [x1, y1] = last && last[0] === "C" ? [2 * cx - last[1], 2 * cy - last[2]] : [cx, cy];
      segs.push(["C", [x1, y1, x2, y2, x, y]]); cx = x; cy = y; last = ["C", x2, y2];
    } else if (C === "Q") {
      const x1 = num() + ox, y1 = num() + oy, x = num() + ox, y = num() + oy;
      segs.push(["Q", [x1, y1, x, y]]); cx = x; cy = y; last = ["Q", x1, y1];
    } else if (C === "T") {
      const x = num() + ox, y = num() + oy;
      const [x1, y1] = last && last[0] === "Q" ? [2 * cx - last[1], 2 * cy - last[2]] : [cx, cy];
      segs.push(["Q", [x1, y1, x, y]]); cx = x; cy = y; last = ["Q", x1, y1];
    } else if (C === "A") {
      const rx = num(), ry = num(), phi = num(), large = num(), sweep = num();
      const x = num() + ox, y = num() + oy;
      for (const s of arcToCubics(cx, cy, rx, ry, phi, !!large, !!sweep, x, y)) segs.push(["C", s]);
      cx = x; cy = y; last = null;
    } else i++;
  }
  return segs;
}

function arcToCubics(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const n = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = den ? Math.sqrt(Math.max(0, n / den)) : 0;
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const k = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / k, alpha = (4 / 3) * Math.tan(step / 4);
  const pt = (a) => { const x = rx * Math.cos(a), y = ry * Math.sin(a); return [cp * x - sp * y + cx, sp * x + cp * y + cy]; };
  const der = (a) => { const x = -rx * Math.sin(a), y = ry * Math.cos(a); return [cp * x - sp * y, sp * x + cp * y]; };
  const out = [];
  for (let j = 0; j < k; j++) {
    const a1 = t1 + j * step, a2 = a1 + step;
    const p1 = pt(a1), p2 = pt(a2), d1 = der(a1), d2 = der(a2);
    out.push([p1[0] + alpha * d1[0], p1[1] + alpha * d1[1], p2[0] - alpha * d2[0], p2[1] - alpha * d2[1], p2[0], p2[1]]);
  }
  return out;
}

export function segmentsBbox(paths) {
  const xs = [], ys = [];
  for (const segs of paths) for (const [, pts] of segs) for (let i = 0; i < pts.length; i += 2) { xs.push(pts[i]); ys.push(pts[i + 1]); }
  if (!xs.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function roundedRectPath(w, h, radii) {
  const k = 0.5522847498, lim = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, lim)));
  const s = [["M", [tl, 0]], ["L", [w - tr, 0]]];
  if (tr) s.push(["C", [w - tr + tr * k, 0, w, tr - tr * k, w, tr]]);
  s.push(["L", [w, h - br]]);
  if (br) s.push(["C", [w, h - br + br * k, w - br + br * k, h, w - br, h]]);
  s.push(["L", [bl, h]]);
  if (bl) s.push(["C", [bl - bl * k, h, 0, h - bl + bl * k, 0, h - bl]]);
  s.push(["L", [0, tl]]);
  if (tl) s.push(["C", [0, tl - tl * k, tl - tl * k, 0, tl, 0]]);
  s.push(["Z", []]);
  return s;
}

export function custGeomXml(paths, x0, y0, w, h, emu, { fill = true } = {}) {
  const pw = Math.max(1, Math.round(w * emu)), ph = Math.max(1, Math.round(h * emu));
  const p = (x, y) => `<a:pt x="${Math.round((x - x0) * emu)}" y="${Math.round((y - y0) * emu)}"/>`;
  const attrs = fill ? "" : ' fill="none"';
  const out = ['<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>'];
  for (const segs of paths) {
    out.push(`<a:path w="${pw}" h="${ph}"${attrs}>`);
    let started = false;
    for (const [kind, pts] of segs) {
      if (kind === "M") { out.push(`<a:moveTo>${p(pts[0], pts[1])}</a:moveTo>`); started = true; }
      else if (!started) continue;
      else if (kind === "L") out.push(`<a:lnTo>${p(pts[0], pts[1])}</a:lnTo>`);
      else if (kind === "C") out.push(`<a:cubicBezTo>${p(pts[0], pts[1])}${p(pts[2], pts[3])}${p(pts[4], pts[5])}</a:cubicBezTo>`);
      else if (kind === "Q") out.push(`<a:quadBezTo>${p(pts[0], pts[1])}${p(pts[2], pts[3])}</a:quadBezTo>`);
      else if (kind === "Z") out.push("<a:close/>");
    }
    out.push("</a:path>");
  }
  out.push("</a:pathLst></a:custGeom>");
  return out.join("");
}

export function prstGeomXml(prst, adj = null) {
  const gds = adj ? Object.entries(adj).map(([k, v]) => `<a:gd name="${k}" fmla="val ${v}"/>`).join("") : "";
  return `<a:prstGeom prst="${prst}"><a:avLst>${gds}</a:avLst></a:prstGeom>`;
}

// XML escaping (also drops characters that are illegal in XML 1.0).
export function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
