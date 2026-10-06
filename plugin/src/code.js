// Figma plugin sandbox: serializes slides/frames into the REST-like JSON the
// converter understands, and answers image/export requests from the UI.

figma.showUI(__html__, { width: 380, height: 560, themeColors: true });

const MIXED = figma.mixed;
const isMixed = (v) => v === MIXED;
const nodesById = new Map();

function box(r) {
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

function invert(m) {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1e-12;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}

function mulPt(m, x, y) {
  return { x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] };
}

// Plugin paints -> REST paints (gradientTransform -> gradientHandlePositions, imageHash -> imageRef).
function paint(p) {
  const out = { type: p.type, visible: p.visible !== false, opacity: p.opacity === undefined ? 1 : p.opacity,
    blendMode: p.blendMode };
  if (p.type === "SOLID") {
    out.color = { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 };
  } else if (p.type.indexOf("GRADIENT_") === 0) {
    const inv = invert(p.gradientTransform);
    const pts = p.type === "GRADIENT_LINEAR" ? [[0, 0.5], [1, 0.5], [0, 1]] : [[0.5, 0.5], [1, 0.5], [0.5, 1]];
    out.gradientHandlePositions = pts.map(([x, y]) => mulPt(inv, x, y));
    out.gradientStops = p.gradientStops.map((s) => ({ position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } }));
  } else if (p.type === "IMAGE") {
    out.imageRef = p.imageHash;
    out.scaleMode = p.scaleMode;
    if (p.imageTransform) out.imageTransform = p.imageTransform;
    if (p.scalingFactor) out.scalingFactor = p.scalingFactor;
    if (p.rotation) out.rotation = p.rotation;
  }
  return out;
}

const paints = (arr) => (Array.isArray(arr) ? arr.map(paint) : []);

function effect(e) {
  const o = { type: e.type, visible: e.visible !== false, radius: e.radius || 0 };
  if (e.color) o.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
  if (e.offset) o.offset = { x: e.offset.x, y: e.offset.y };
  if (e.spread) o.spread = e.spread;
  return o;
}

function geometry(list) {
  try {
    return (list || []).map((g) => ({ path: g.data, windingRule: g.windingRule }));
  } catch (e) {
    return [];
  }
}

function weightOf(style) {
  const s = (style || "").toLowerCase().replace(/[\s_-]/g, "");
  const table = [["thin", 100], ["hairline", 100], ["extralight", 200], ["ultralight", 200], ["light", 300],
    ["medium", 500], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800],
    ["black", 900], ["heavy", 900], ["bold", 700]];
  for (const [k, v] of table) if (s.indexOf(k) >= 0) return v;
  return 400;
}

function textStyle(seg) {
  const size = seg.fontSize;
  const st = {
    fontFamily: seg.fontName.family,
    fontPostScriptName: seg.fontName.style,
    fontWeight: seg.fontWeight || weightOf(seg.fontName.style),
    italic: /italic|oblique/i.test(seg.fontName.style),
    fontSize: size,
    textCase: seg.textCase,
    textDecoration: seg.textDecoration,
  };
  const ls = seg.letterSpacing;
  st.letterSpacing = ls ? (ls.unit === "PERCENT" ? (ls.value / 100) * size : ls.value) : 0;
  const lh = seg.lineHeight;
  if (!lh || lh.unit === "AUTO") st.lineHeightUnit = "INTRINSIC_%";
  else if (lh.unit === "PIXELS") { st.lineHeightUnit = "PIXELS"; st.lineHeightPx = lh.value; }
  else { st.lineHeightUnit = "FONT_SIZE_%"; st.lineHeightPx = (lh.value / 100) * size; }
  if (seg.hyperlink && seg.hyperlink.type === "URL") st.hyperlink = { type: "URL", url: seg.hyperlink.value };
  return st;
}

function serializeText(node, out) {
  out.characters = node.characters;
  const fields = ["fontName", "fontSize", "fontWeight", "fills", "letterSpacing", "lineHeight", "textCase",
    "textDecoration", "hyperlink", "listOptions", "indentation"];
  let segs;
  try { segs = node.getStyledTextSegments(fields); } catch (e) { segs = []; }
  if (!segs.length) return;
  const table = {};
  const overrides = new Array(node.characters.length).fill(0);
  const baseKey = JSON.stringify([textStyle(segs[0]), paints(segs[0].fills)]);
  const keys = new Map([[baseKey, 0]]);
  for (const seg of segs) {
    const st = textStyle(seg);
    const fills = paints(seg.fills);
    const key = JSON.stringify([st, fills]);
    if (!keys.has(key)) {
      const id = keys.size;
      keys.set(key, id);
      table[String(id)] = Object.assign({}, st, { fills });
    }
    const id = keys.get(key);
    for (let i = seg.start; i < seg.end; i++) overrides[i] = id;
  }
  out.style = Object.assign(textStyle(segs[0]), {
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    paragraphSpacing: isMixed(node.paragraphSpacing) ? 0 : node.paragraphSpacing,
  });
  out.fills = paints(segs[0].fills);
  out.characterStyleOverrides = overrides;
  out.styleOverrideTable = table;
  // Per paragraph list type / indentation.
  const lineTypes = [], lineIndents = [];
  let start = 0;
  for (const para of node.characters.split("\n")) {
    const seg = segs.find((s) => s.start <= start && start < s.end) || segs[segs.length - 1];
    lineTypes.push(seg.listOptions ? seg.listOptions.type : "NONE");
    lineIndents.push(seg.indentation || 0);
    start += para.length + 1;
  }
  out.lineTypes = lineTypes;
  out.lineIndentations = lineIndents;
}

function serialize(node) {
  nodesById.set(node.id, node);
  const out = { id: node.id, name: node.name, type: node.type, visible: node.visible !== false };
  if ("opacity" in node) out.opacity = node.opacity;
  if ("isMask" in node) out.isMask = node.isMask;
  if ("clipsContent" in node) out.clipsContent = node.clipsContent;
  if ("width" in node) out.size = { x: node.width, y: node.height };
  if ("absoluteTransform" in node) out.absoluteTransform = node.absoluteTransform;
  if ("relativeTransform" in node) out.relativeTransform = node.relativeTransform;
  if ("absoluteBoundingBox" in node) out.absoluteBoundingBox = box(node.absoluteBoundingBox);
  if ("absoluteRenderBounds" in node) out.absoluteRenderBounds = box(node.absoluteRenderBounds);
  out.rasterBounds = out.absoluteRenderBounds || out.absoluteBoundingBox;
  if ("blendMode" in node) out.blendMode = node.blendMode;
  if ("effects" in node && Array.isArray(node.effects)) out.effects = node.effects.map(effect);

  if ("fills" in node && !isMixed(node.fills)) out.fills = paints(node.fills);
  if ("strokes" in node) out.strokes = paints(node.strokes);
  if ("strokeWeight" in node) {
    if (isMixed(node.strokeWeight)) {
      out.individualStrokeWeights = { top: node.strokeTopWeight, right: node.strokeRightWeight,
        bottom: node.strokeBottomWeight, left: node.strokeLeftWeight };
      out.strokeWeight = Math.max(node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight);
    } else out.strokeWeight = node.strokeWeight;
  }
  if ("strokeAlign" in node) out.strokeAlign = node.strokeAlign;
  if ("strokeCap" in node && !isMixed(node.strokeCap)) out.strokeCap = node.strokeCap;
  if ("strokeJoin" in node && !isMixed(node.strokeJoin)) out.strokeJoin = node.strokeJoin;
  if ("dashPattern" in node && node.dashPattern.length) out.strokeDashes = node.dashPattern.slice();
  if ("cornerRadius" in node) {
    if (isMixed(node.cornerRadius)) {
      out.rectangleCornerRadii = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    } else out.cornerRadius = node.cornerRadius;
  }
  if (node.type === "ELLIPSE") out.arcData = node.arcData;
  if (["VECTOR", "STAR", "POLYGON", "BOOLEAN_OPERATION", "ELLIPSE", "LINE", "HIGHLIGHT", "WASHI_TAPE"].indexOf(node.type) >= 0 ||
      (node.type === "ELLIPSE")) {
    if ("fillGeometry" in node) out.fillGeometry = geometry(node.fillGeometry);
    if ("strokeGeometry" in node) out.strokeGeometry = geometry(node.strokeGeometry);
  }
  if (node.type === "POLYGON") out.type = "REGULAR_POLYGON";
  if (node.type === "TEXT") serializeText(node, out);
  if ("children" in node && node.type !== "INSTANCE_SWAP") out.children = node.children.map(serialize);
  return out;
}

function slideTargets() {
  const sel = figma.currentPage.selection;
  const pickSlide = (n) => {
    let cur = n;
    while (cur && cur.type !== "SLIDE" && cur.parent && cur.parent.type !== "PAGE") cur = cur.parent;
    return cur;
  };
  if (figma.editorType === "slides") {
    const grid = typeof figma.getSlideGrid === "function" ? figma.getSlideGrid() : null;
    const all = grid ? [].concat(...grid) : figma.currentPage.findAllWithCriteria({ types: ["SLIDE"] });
    const chosen = new Set(sel.map(pickSlide).filter((n) => n && n.type === "SLIDE").map((n) => n.id));
    const slides = all.filter((s) => !s.isSkippedSlide);
    return { nodes: chosen.size ? all.filter((s) => chosen.has(s.id)) : slides, fromSelection: chosen.size > 0 };
  }
  if (sel.length) {
    const tops = [];
    for (const n of sel) {
      const t = pickSlide(n);
      if (t && tops.indexOf(t) < 0) tops.push(t);
    }
    return { nodes: tops, fromSelection: true };
  }
  const frames = figma.currentPage.children.filter((n) =>
    n.visible && ["FRAME", "COMPONENT", "INSTANCE", "SECTION"].indexOf(n.type) >= 0);
  return { nodes: frames, fromSelection: false };
}

function usedFonts(nodes) {
  const seen = new Map();
  for (const root of nodes) {
    const texts = root.type === "TEXT" ? [root] : ("findAllWithCriteria" in root ? root.findAllWithCriteria({ types: ["TEXT"] }) : []);
    for (const t of texts) {
      if (!t.visible) continue;
      let segs = [];
      try { segs = t.getStyledTextSegments(["fontName", "fontWeight"]); } catch (e) { /* ignore */ }
      for (const seg of segs) {
        const italic = /italic|oblique/i.test(seg.fontName.style);
        const weight = seg.fontWeight || weightOf(seg.fontName.style);
        const key = `${seg.fontName.family}|${weight}|${italic}`;
        if (!seen.has(key)) seen.set(key, { family: seg.fontName.family, style: seg.fontName.style, weight, italic });
      }
    }
  }
  return [...seen.values()];
}

function describe() {
  const { nodes, fromSelection } = slideTargets();
  figma.ui.postMessage({ type: "info", count: nodes.length, fromSelection, editor: figma.editorType,
    fonts: usedFonts(nodes) });
}

async function storedFonts() {
  const out = [];
  try {
    for (const key of await figma.clientStorage.keysAsync()) {
      if (key.indexOf("font:") !== 0) continue;
      const v = await figma.clientStorage.getAsync(key);
      if (v && v.bytes) out.push({ key, name: v.name, bytes: v.bytes });
    }
  } catch (e) { /* storage unavailable */ }
  return out;
}

let describeTimer = null;

figma.on("selectionchange", () => {
  if (describeTimer) clearTimeout(describeTimer);
  describeTimer = setTimeout(describe, 250);
});

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "ready") {
      figma.ui.postMessage({ type: "stored-fonts", fonts: await storedFonts() });
      describe();
    } else if (msg.type === "font-save") {
      try {
        await figma.clientStorage.setAsync(msg.key, { name: msg.name, bytes: msg.bytes });
      } catch (e) {
        figma.ui.postMessage({ type: "font-save-failed", name: msg.name, message: String(e && e.message || e) });
      }
    } else if (msg.type === "font-remove") {
      await figma.clientStorage.deleteAsync(msg.key);
    }
    else if (msg.type === "collect") {
      const { nodes } = slideTargets();
      nodesById.clear();
      const tree = nodes.map(serialize);
      figma.ui.postMessage({ type: "tree", slides: tree });
    } else if (msg.type === "image") {
      const img = figma.getImageByHash(msg.hash);
      const bytes = img ? await img.getBytesAsync() : null;
      figma.ui.postMessage({ type: "image", reqId: msg.reqId, bytes });
    } else if (msg.type === "render") {
      const node = nodesById.get(msg.id) || (await figma.getNodeByIdAsync(msg.id));
      let bytes = null;
      if (node && "exportAsync" in node) {
        bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: msg.scale || 2 } });
      }
      figma.ui.postMessage({ type: "render", reqId: msg.reqId, bytes });
    } else if (msg.type === "notify") {
      figma.notify(msg.text, { error: !!msg.error });
    } else if (msg.type === "close") {
      figma.closePlugin();
    }
  } catch (e) {
    figma.ui.postMessage({ type: "error", reqId: msg.reqId, message: String(e && e.message || e) });
  }
};
