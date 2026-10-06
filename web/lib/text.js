// Figma TEXT node -> DrawingML text body.
import { esc } from "./geometry.js";
import { colorXml, effectsXml, fillXml, visiblePaints } from "./paint.js";

const ALIGN_H = { LEFT: "l", CENTER: "ctr", RIGHT: "r", JUSTIFIED: "just" };
const ALIGN_V = { TOP: "t", CENTER: "ctr", BOTTOM: "b" };
const WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 500: "Medium", 600: "SemiBold", 800: "ExtraBold", 900: "Black" };

// Paragraphs as lists of [text, styleId]; override indices are UTF-16 based like JS strings.
function runs(node) {
  const chars = node.characters || "";
  const ovr = node.characterStyleOverrides || [];
  const paras = [[]];
  let u16 = 0;
  for (const ch of chars) {
    const sid = u16 < ovr.length ? ovr[u16] : 0;
    u16 += ch.length;
    if (ch === "\n") { paras.push([]); continue; }
    const p = paras[paras.length - 1];
    if (p.length && p[p.length - 1][1] === sid) p[p.length - 1][0] += ch;
    else p.push([ch, sid]);
  }
  return paras;
}

function applyCase(text, tc) {
  if (tc === "LOWER") return text.toLowerCase();
  if (tc === "TITLE") return text.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return text;
}

function typeface(style, mode) {
  const family = style.fontFamily || "Arial";
  const weight = +style.fontWeight || 400;
  if (mode === "names") {
    const name = WEIGHT_NAMES[Math.round(weight / 100) * 100];
    if (name && weight !== 400 && weight !== 700) return [`${family} ${name}`, false];
    return [family, weight >= 700];
  }
  return [family, weight >= 600];
}

export function textBodyXml(node, conv, opacity, w, h) {
  const ctx = conv.ctx;
  const base = node.style || {};
  const table = node.styleOverrideTable || {};
  const pt = (ctx.emu / 9525) * 0.75; // px -> pt incl. slide scaling
  const nodeFills = node.fills || [];
  const effects = effectsXml(node, ctx, opacity);
  const lineTypes = node.lineTypes || [];
  const lineIndents = node.lineIndentations || [];

  const styleOf = (sid) => {
    const o = table[String(sid)] || {};
    const st = { ...base };
    for (const [k, v] of Object.entries(o)) if (k !== "fills") st[k] = v;
    return [st, o.fills ?? nodeFills];
  };

  const rpr = (sid, end = false) => {
    const [st, fills] = styleOf(sid);
    const size = +st.fontSize || 12;
    const attrs = [`lang="${conv.lang}"`, `sz="${Math.max(100, Math.min(400000, Math.round(size * pt * 100)))}"`];
    const [face, bold] = typeface(st, conv.fontWeights);
    if (bold) attrs.push('b="1"');
    if (st.italic) attrs.push('i="1"');
    if (st.textDecoration === "UNDERLINE") attrs.push('u="sng"');
    else if (st.textDecoration === "STRIKETHROUGH") attrs.push('strike="sngStrike"');
    if (st.textCase === "UPPER") attrs.push('cap="all"');
    else if (st.textCase === "SMALL_CAPS" || st.textCase === "SMALL_CAPS_FORCED") attrs.push('cap="small"');
    const ls = +st.letterSpacing || 0;
    if (ls) attrs.push(`spc="${Math.round(ls * pt * 100)}"`);
    attrs.push('dirty="0"');
    let inner = "";
    const strokes = visiblePaints(node.strokes);
    const sw = +node.strokeWeight || 0;
    if (strokes.length && sw > 0 && strokes[strokes.length - 1].type === "SOLID") {
      const s = strokes[strokes.length - 1];
      inner += `<a:ln w="${Math.round(sw * ctx.emu)}"><a:solidFill>${colorXml(s.color, (s.opacity ?? 1) * opacity)}</a:solidFill></a:ln>`;
    }
    const paints = visiblePaints(fills).filter((p) => p.type !== "IMAGE");
    if (paints.length) inner += fillXml(paints[paints.length - 1], ctx, w, h, [0, 0, w, h], opacity, null, false) || "";
    else inner += "<a:noFill/>";
    inner += effects;
    const f = esc(face);
    inner += `<a:latin typeface="${f}"/><a:ea typeface="${f}"/><a:cs typeface="${f}"/>`;
    const link = st.hyperlink || {};
    if (!end && link.type === "URL" && link.url) inner += `<a:hlinkClick r:id="${conv.hyperlink(link.url)}"/>`;
    const tag = end ? "a:endParaRPr" : "a:rPr";
    return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
  };

  const paragraphs = runs(node);
  const parasXml = paragraphs.map((rs, idx) => {
    const firstSid = rs.length ? rs[0][1] : 0;
    const [st] = styleOf(firstSid);
    const pAttrs = [`algn="${ALIGN_H[base.textAlignHorizontal] || "l"}"`];
    let ppr = "";
    const unit = st.lineHeightUnit || "INTRINSIC_%";
    if (unit !== "INTRINSIC_%" && st.lineHeightPx) {
      ppr += `<a:lnSpc><a:spcPts val="${Math.round(st.lineHeightPx * pt * 100)}"/></a:lnSpc>`;
    }
    const paraSp = +st.paragraphSpacing || 0;
    if (paraSp && idx < paragraphs.length - 1) ppr += `<a:spcAft><a:spcPts val="${Math.round(paraSp * pt * 100)}"/></a:spcAft>`;
    const lt = lineTypes[idx] || "NONE";
    const level = +lineIndents[idx] || 0;
    const sizePx = +st.fontSize || 12;
    if (lt === "ORDERED" || lt === "UNORDERED") {
      const ind = Math.round(sizePx * 1.2 * ctx.emu);
      pAttrs.push(`marL="${ind * Math.max(1, level)}" indent="${-ind}"`);
      ppr += lt === "ORDERED" ? '<a:buFontTx/><a:buAutoNum type="arabicPeriod"/>' : '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>';
    } else {
      if (level) pAttrs.push(`marL="${Math.round(sizePx * 1.2 * level * ctx.emu)}"`);
      ppr += "<a:buNone/>";
    }
    const out = [`<a:p><a:pPr ${pAttrs.join(" ")}>${ppr}</a:pPr>`];
    for (const [text, sid] of rs) {
      const [s] = styleOf(sid);
      const parts = applyCase(text, s.textCase).split(" ");
      parts.forEach((part, j) => {
        if (j) out.push(`<a:br>${rpr(sid)}</a:br>`);
        if (part) out.push(`<a:r>${rpr(sid)}<a:t>${esc(part)}</a:t></a:r>`);
      });
    }
    out.push(rpr(rs.length ? rs[rs.length - 1][1] : firstSid, true));
    out.push("</a:p>");
    return out.join("");
  });

  const auto = base.textAutoResize || node.textAutoResize;
  const wrap = auto === "WIDTH_AND_HEIGHT" ? "none" : "square";
  const anchor = ALIGN_V[base.textAlignVertical] || "t";
  const body = `<a:bodyPr wrap="${wrap}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>`;
  return `<p:txBody>${body}${parasXml.join("")}</p:txBody>`;
}
