"""Figma TEXT node -> DrawingML text body."""

from __future__ import annotations

from xml.sax.saxutils import escape, quoteattr

from .paint import color_xml, effects_xml, fill_xml, visible_paints

_ALIGN_H = {"LEFT": "l", "CENTER": "ctr", "RIGHT": "r", "JUSTIFIED": "just"}
_ALIGN_V = {"TOP": "t", "CENTER": "ctr", "BOTTOM": "b"}
_WEIGHT_NAMES = {100: "Thin", 200: "ExtraLight", 300: "Light", 500: "Medium",
                 600: "SemiBold", 800: "ExtraBold", 900: "Black"}


def _runs(node: dict):
    """Yield paragraphs as lists of (text, style_id); handles UTF-16 indexed overrides."""
    chars = node.get("characters") or ""
    ovr = node.get("characterStyleOverrides") or []
    paragraphs: list[list[tuple[str, int]]] = [[]]
    u16 = 0
    for ch in chars:
        sid = ovr[u16] if u16 < len(ovr) else 0
        u16 += 2 if ord(ch) > 0xFFFF else 1
        if ch == "\n":
            paragraphs.append([])
            continue
        para = paragraphs[-1]
        if para and para[-1][1] == sid:
            para[-1] = (para[-1][0] + ch, sid)
        else:
            para.append((ch, sid))
    return paragraphs


def _apply_case(text: str, case: str | None) -> str:
    if case == "LOWER":
        return text.lower()
    if case == "TITLE":
        return text.title()
    return text


def _typeface(style: dict, mode: str) -> tuple[str, bool]:
    family = style.get("fontFamily") or "Arial"
    weight = int(style.get("fontWeight") or 400)
    if mode == "names":
        name = _WEIGHT_NAMES.get(int(round(weight / 100.0)) * 100)
        if name and weight not in (400, 700):
            return f"{family} {name}", False
        return family, weight >= 700
    return family, weight >= 600


def text_body_xml(node: dict, conv, opacity: float, w: float, h: float) -> str:
    ctx = conv.ctx
    base = node.get("style") or {}
    table = node.get("styleOverrideTable") or {}
    pt = ctx.emu / 9525 * 0.75  # Figma px -> points (incl. slide scaling)
    node_fills = node.get("fills") or []
    effects = effects_xml(node, ctx, opacity)
    line_types = node.get("lineTypes") or []
    line_indents = node.get("lineIndentations") or []

    def style_of(sid: int) -> tuple[dict, list]:
        o = table.get(str(sid)) or {}
        st = {**base, **{k: v for k, v in o.items() if k != "fills"}}
        return st, o.get("fills", node_fills)

    def rpr(sid: int, end: bool = False) -> str:
        st, fills = style_of(sid)
        size = float(st.get("fontSize") or 12)
        attrs = [f'lang="{conv.lang}"', f'sz="{max(100, min(400000, int(round(size * pt * 100))))}"']
        face, bold = _typeface(st, conv.font_weights)
        if bold:
            attrs.append('b="1"')
        if st.get("italic"):
            attrs.append('i="1"')
        deco = st.get("textDecoration")
        if deco == "UNDERLINE":
            attrs.append('u="sng"')
        elif deco == "STRIKETHROUGH":
            attrs.append('strike="sngStrike"')
        case = st.get("textCase")
        if case == "UPPER":
            attrs.append('cap="all"')
        elif case in ("SMALL_CAPS", "SMALL_CAPS_FORCED"):
            attrs.append('cap="small"')
        ls = float(st.get("letterSpacing") or 0)
        if ls:
            attrs.append(f'spc="{int(round(ls * pt * 100))}"')
        attrs.append('dirty="0"')
        inner = ""
        strokes = visible_paints(node.get("strokes"))
        if strokes and float(node.get("strokeWeight") or 0) > 0 and strokes[-1].get("type") == "SOLID":
            inner += (f'<a:ln w="{int(round(float(node["strokeWeight"]) * ctx.emu))}">'
                      f'<a:solidFill>{color_xml(strokes[-1]["color"], float(strokes[-1].get("opacity", 1)) * opacity)}'
                      f"</a:solidFill></a:ln>")
        paints = [p for p in visible_paints(fills) if p.get("type") != "IMAGE"]
        if paints:
            paint = paints[-1]
            if paint.get("type") in ("GRADIENT_ANGULAR", "GRADIENT_DIAMOND"):
                # Text runs cannot hold picture fills -> nearest native gradient.
                paint = dict(paint, type="GRADIENT_RADIAL")
            fx = fill_xml(paint, _NoRasterCtx(ctx), w, h, (0, 0, w, h), opacity)
            inner += fx or ""
        else:
            inner += "<a:noFill/>"
        inner += effects
        f = quoteattr(face)
        inner += f"<a:latin typeface={f}/><a:ea typeface={f}/><a:cs typeface={f}/>"
        link = st.get("hyperlink") or {}
        if not end and link.get("type") == "URL" and link.get("url"):
            inner += f'<a:hlinkClick r:id="{conv.hyperlink(link["url"])}"/>'
        tag = "a:endParaRPr" if end else "a:rPr"
        return f"<{tag} {' '.join(attrs)}>{inner}</{tag}>"

    paras_xml = []
    paragraphs = _runs(node)
    for idx, runs in enumerate(paragraphs):
        first_sid = runs[0][1] if runs else 0
        st, _ = style_of(first_sid)
        ppr_attrs = [f'algn="{_ALIGN_H.get(base.get("textAlignHorizontal", "LEFT"), "l")}"']
        ppr = ""
        unit = st.get("lineHeightUnit", "INTRINSIC_%")
        if unit != "INTRINSIC_%" and st.get("lineHeightPx"):
            # Figma always reports the resolved line height in px -> exact points.
            ppr += f'<a:lnSpc><a:spcPts val="{int(round(float(st["lineHeightPx"]) * pt * 100))}"/></a:lnSpc>'
        para_sp = float(st.get("paragraphSpacing") or 0)
        if para_sp and idx < len(paragraphs) - 1:
            ppr += f'<a:spcAft><a:spcPts val="{int(round(para_sp * pt * 100))}"/></a:spcAft>'
        lt = line_types[idx] if idx < len(line_types) else "NONE"
        level = int(line_indents[idx]) if idx < len(line_indents) and line_indents[idx] else 0
        size_px = float(st.get("fontSize") or 12)
        if lt in ("ORDERED", "UNORDERED"):
            indent = int(round(size_px * 1.2 * ctx.emu))
            ppr_attrs.append(f'marL="{indent * max(1, level)}" indent="{-indent}"')
            if lt == "ORDERED":
                ppr += '<a:buFontTx/><a:buAutoNum type="arabicPeriod"/>'
            else:
                ppr += '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>'
        else:
            if level:
                ppr_attrs.append(f'marL="{int(round(size_px * 1.2 * level * ctx.emu))}"')
            ppr += "<a:buNone/>"
        out = [f"<a:p><a:pPr {' '.join(ppr_attrs)}>{ppr}</a:pPr>"]
        for text, sid in runs:
            s, _ = style_of(sid)
            text = _apply_case(text, s.get("textCase"))
            parts = text.split(" ")
            for j, part in enumerate(parts):
                if j:
                    out.append(f"<a:br>{rpr(sid)}</a:br>")
                if part:
                    out.append(f"<a:r>{rpr(sid)}<a:t>{escape(part)}</a:t></a:r>")
        last_sid = runs[-1][1] if runs else first_sid
        out.append(rpr(last_sid, end=True))
        out.append("</a:p>")
        paras_xml.append("".join(out))

    auto = node.get("style", {}).get("textAutoResize") or node.get("textAutoResize")
    wrap = "none" if auto == "WIDTH_AND_HEIGHT" else "square"
    anchor = _ALIGN_V.get(base.get("textAlignVertical", "TOP"), "t")
    body = (f'<a:bodyPr wrap="{wrap}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="{anchor}" '
            f'rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>')
    return f"<p:txBody>{body}{''.join(paras_xml)}</p:txBody>"


class _NoRasterCtx:
    """Text fills must stay native (no picture fills inside runs)."""

    def __init__(self, ctx):
        self.emu = ctx.emu
        self.rasterize_gradients = False
        self._ctx = ctx

    def embed(self, data: bytes) -> str:
        return self._ctx.embed(data)
