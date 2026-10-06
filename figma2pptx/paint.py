"""Figma paints/effects -> DrawingML fill, line and effect XML."""

from __future__ import annotations

import io
import math
from typing import Protocol

import numpy as np
from PIL import Image

EMU_PER_PX = 9525  # 96 dpi


class Ctx(Protocol):
    emu: float  # EMU per Figma px
    rasterize_gradients: bool

    def embed(self, data: bytes) -> str: ...


# --------------------------------------------------------------------------- colors

def hex_rgb(c: dict) -> str:
    return "".join(f"{max(0, min(255, int(round(float(c.get(k, 0)) * 255)))):02X}" for k in ("r", "g", "b"))


def color_xml(c: dict, alpha: float = 1.0) -> str:
    a = max(0.0, min(1.0, float(c.get("a", 1.0)) * alpha))
    if a >= 0.99999:
        return f'<a:srgbClr val="{hex_rgb(c)}"/>'
    return f'<a:srgbClr val="{hex_rgb(c)}"><a:alpha val="{int(round(a * 100000))}"/></a:srgbClr>'


def visible_paints(paints) -> list[dict]:
    return [p for p in (paints or []) if p.get("visible", True) and float(p.get("opacity", 1.0)) > 0]


def _stops(paint: dict) -> list[tuple[float, tuple[float, float, float, float]]]:
    out = []
    for s in paint.get("gradientStops") or []:
        c = s.get("color", {})
        out.append((float(s.get("position", 0.0)),
                    (float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))))
    out.sort(key=lambda s: s[0])
    return out or [(0.0, (0, 0, 0, 1)), (1.0, (0, 0, 0, 1))]


def _color_at(stops, t: float):
    if t <= stops[0][0]:
        return stops[0][1]
    if t >= stops[-1][0]:
        return stops[-1][1]
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if p0 <= t <= p1:
            f = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            return tuple(a + (b - a) * f for a, b in zip(c0, c1))
    return stops[-1][1]


def _gs(pos: float, c, alpha: float) -> str:
    col = {"r": c[0], "g": c[1], "b": c[2], "a": c[3]}
    return f'<a:gs pos="{int(round(max(0.0, min(1.0, pos)) * 100000))}">{color_xml(col, alpha)}</a:gs>'


def _remap_stops(stops, t0: float, t1: float, alpha: float) -> str:
    """Map Figma gradient parameter range [t0, t1] onto DrawingML 0..1."""
    span = t1 - t0
    if abs(span) < 1e-9:
        return _gs(0, _color_at(stops, t0), alpha) + _gs(1, _color_at(stops, t0), alpha)
    pts = [(0.0, _color_at(stops, t0))]
    for p, c in stops:
        u = (p - t0) / span
        if 0.0 < u < 1.0:
            pts.append((u, c))
    pts.append((1.0, _color_at(stops, t1)))
    pts.sort(key=lambda x: x[0])
    return "".join(_gs(u, c, alpha) for u, c in pts)


def _handles_px(paint: dict, nw: float, nh: float, box) -> list[tuple[float, float]]:
    bx, by, _bw, _bh = box
    hs = paint.get("gradientHandlePositions") or []
    if len(hs) < 3:
        # Figma default handles for a missing transform.
        hs = [{"x": 0.0, "y": 0.5}, {"x": 1.0, "y": 0.5}, {"x": 0.0, "y": 1.0}]
    return [(float(h["x"]) * nw - bx, float(h["y"]) * nh - by) for h in hs[:3]]


def linear_gradient_xml(paint, nw, nh, box, alpha) -> str:
    _bx, _by, bw, bh = box
    stops = _stops(paint)
    (sx, sy), (ex, ey), (wx, wy) = _handles_px(paint, nw, nh, box)
    ux, uy, vx, vy = ex - sx, ey - sy, wx - sx, wy - sy
    det = ux * vy - uy * vx
    if ux * ux + uy * uy < 1e-9:
        return f"<a:solidFill>{color_xml(_c(stops[0][1]), alpha)}</a:solidFill>"
    corners = ((0, 0), (bw, 0), (0, bh), (bw, bh))
    if abs(det) > 1e-9:
        # Figma's gradient parameter is the first coordinate of the inverse affine
        # (start, end, width handles). Iso-lines run along the width handle, so the
        # DrawingML direction is the normal of that handle.
        ts = [((cx - sx) * vy - (cy - sy) * vx) / det for cx, cy in corners]
        nx, ny = vy, -vx
        if nx * ux + ny * uy < 0:
            nx, ny = -nx, -ny
    else:
        l2 = ux * ux + uy * uy
        ts = [((cx - sx) * ux + (cy - sy) * uy) / l2 for cx, cy in corners]
        nx, ny = ux, uy
    ang = math.degrees(math.atan2(ny, nx)) % 360.0
    gs = _remap_stops(stops, min(ts), max(ts), alpha)
    return (f'<a:gradFill flip="none" rotWithShape="1"><a:gsLst>{gs}</a:gsLst>'
            f'<a:lin ang="{int(round(ang * 60000)) % 21600000}" scaled="0"/></a:gradFill>')


def radial_gradient_xml(paint, nw, nh, box, alpha) -> str:
    _bx, _by, bw, bh = box
    stops = _stops(paint)
    (cx, cy), (ex, ey), (wx, wy) = _handles_px(paint, nw, nh, box)
    bw = bw or 1.0
    bh = bh or 1.0
    fx, fy = cx / bw, cy / bh  # focus, normalized to the box
    # Figma radius in normalized box units (average of both ellipse axes).
    r1 = math.hypot((ex - cx) / bw, (ey - cy) / bh)
    r2 = math.hypot((wx - cx) / bw, (wy - cy) / bh)
    r_fig = (r1 + r2) / 2 if r2 else r1
    # DrawingML "circle" path: the outer edge reaches the farthest box corner.
    r_ppt = max(math.hypot(fx - x, fy - y) for x, y in ((0, 0), (1, 0), (0, 1), (1, 1)))
    t1 = r_ppt / r_fig if r_fig > 1e-9 else 1.0
    gs = _remap_stops(stops, 0.0, t1, alpha)
    l, t = fx, fy
    r, b = 1 - fx, 1 - fy
    return (f'<a:gradFill flip="none" rotWithShape="1"><a:gsLst>{gs}</a:gsLst>'
            f'<a:path path="circle"><a:fillToRect l="{int(l * 100000)}" t="{int(t * 100000)}" '
            f'r="{int(r * 100000)}" b="{int(b * 100000)}"/></a:path>'
            f'<a:tileRect/></a:gradFill>')


def _c(c):
    return {"r": c[0], "g": c[1], "b": c[2], "a": c[3]}


def render_gradient_png(paint, nw, nh, box, max_px: int = 1600) -> bytes:
    """Rasterize any Figma gradient exactly (used for angular/diamond or on demand)."""
    _bx, _by, bw, bh = box
    bw, bh = max(bw, 1e-3), max(bh, 1e-3)
    scale = min(2.0, max_px / max(bw, bh))
    W = max(4, int(math.ceil(bw * scale)))
    H = max(4, int(math.ceil(bh * scale)))
    (x0, y0), (x1, y1), (x2, y2) = _handles_px(paint, nw, nh, box)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float64)
    px = (xs + 0.5) / W * bw - x0
    py = (ys + 0.5) / H * bh - y0
    ux, uy, vx, vy = x1 - x0, y1 - y0, x2 - x0, y2 - y0
    det = ux * vy - uy * vx
    kind = paint.get("type")
    if abs(det) < 1e-9:
        l2 = ux * ux + uy * uy or 1.0
        gx = (px * ux + py * uy) / l2
        gy = np.zeros_like(gx)
    else:
        gx = (px * vy - py * vx) / det
        gy = (ux * py - uy * px) / det
    if kind == "GRADIENT_LINEAR":
        t = gx
    elif kind == "GRADIENT_RADIAL":
        t = np.sqrt(gx * gx + gy * gy)
    elif kind == "GRADIENT_ANGULAR":
        t = np.mod(np.arctan2(gy, gx) / (2 * math.pi), 1.0)
    else:  # GRADIENT_DIAMOND
        t = np.abs(gx) + np.abs(gy)
    stops = _stops(paint)
    pos = np.array([s[0] for s in stops])
    rgba = np.zeros((H, W, 4))
    for ch in range(4):
        rgba[..., ch] = np.interp(t, pos, np.array([s[1][ch] for s in stops]))
    rgba[..., 3] *= float(paint.get("opacity", 1.0))
    img = Image.fromarray(np.clip(np.round(rgba * 255), 0, 255).astype(np.uint8), "RGBA")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _blip_fill(r_id: str, alpha: float, inner: str = '<a:stretch><a:fillRect/></a:stretch>', src: str = "") -> str:
    amt = ""
    if alpha < 0.99999:
        amt = f'<a:alphaModFix amt="{int(round(max(0.0, alpha) * 100000))}"/>'
    return f'<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="{r_id}">{amt}</a:blip>{src}{inner}</a:blipFill>'


def image_fill_xml(paint: dict, data: bytes, ctx: Ctx, nw, nh, box, alpha) -> str:
    _bx, _by, bw, bh = box
    try:
        with Image.open(io.BytesIO(data)) as im:
            iw, ih = im.size
    except Exception:
        iw, ih = 1, 1
    rot = int(paint.get("rotation") or 0) % 360
    if rot:
        try:
            with Image.open(io.BytesIO(data)) as im:
                im = im.rotate(-rot, expand=True)
                buf = io.BytesIO()
                im.save(buf, "PNG")
                data = buf.getvalue()
                iw, ih = im.size
        except Exception:
            pass
    r_id = ctx.embed(data)
    mode = paint.get("scaleMode", "FILL")
    bw = bw or 1.0
    bh = bh or 1.0
    ia, ba = iw / ih if ih else 1.0, bw / bh
    def pct(v):
        return int(round(v * 100000))
    if mode == "FIT":
        if ia > ba:
            pad = (1 - ba / ia) / 2
            inner = f'<a:stretch><a:fillRect t="{pct(pad)}" b="{pct(pad)}"/></a:stretch>'
        else:
            pad = (1 - ia / ba) / 2
            inner = f'<a:stretch><a:fillRect l="{pct(pad)}" r="{pct(pad)}"/></a:stretch>'
        return _blip_fill(r_id, alpha, inner)
    if mode == "TILE":
        sf = float(paint.get("scalingFactor") or 1.0)
        s = pct(sf * ctx.emu / EMU_PER_PX)
        return _blip_fill(r_id, alpha, f'<a:tile tx="0" ty="0" sx="{s}" sy="{s}" flip="none" algn="tl"/>')
    if mode == "CROP" and paint.get("imageTransform"):
        m = paint["imageTransform"]
        x0, y0 = float(m[0][2]), float(m[1][2])
        sw, sh = float(m[0][0]) or 1.0, float(m[1][1]) or 1.0
        src = f'<a:srcRect l="{pct(x0)}" t="{pct(y0)}" r="{pct(1 - x0 - sw)}" b="{pct(1 - y0 - sh)}"/>'
        return _blip_fill(r_id, alpha, src=src)
    # FILL (cover)
    if ia > ba:
        crop = (1 - ba / ia) / 2
        src = f'<a:srcRect l="{pct(crop)}" r="{pct(crop)}"/>'
    else:
        crop = (1 - ia / ba) / 2
        src = f'<a:srcRect t="{pct(crop)}" b="{pct(crop)}"/>'
    return _blip_fill(r_id, alpha, src=src)


def fill_xml(paint: dict, ctx: Ctx, nw: float, nh: float, box, opacity: float, image_bytes=None) -> str | None:
    """One Figma paint -> one DrawingML fill element (or None if unsupported/missing)."""
    alpha = float(paint.get("opacity", 1.0)) * opacity
    kind = paint.get("type")
    if kind == "SOLID":
        return f"<a:solidFill>{color_xml(paint.get('color', {}), alpha)}</a:solidFill>"
    if kind and kind.startswith("GRADIENT_"):
        native = kind in ("GRADIENT_LINEAR", "GRADIENT_RADIAL") and not ctx.rasterize_gradients
        if native and kind == "GRADIENT_LINEAR":
            return linear_gradient_xml(paint, nw, nh, box, alpha)
        if native and kind == "GRADIENT_RADIAL":
            return radial_gradient_xml(paint, nw, nh, box, alpha)
        png = render_gradient_png(dict(paint, opacity=1.0), nw, nh, box)
        return _blip_fill(ctx.embed(png), alpha)
    if kind == "IMAGE" and image_bytes:
        return image_fill_xml(paint, image_bytes, ctx, nw, nh, box, alpha)
    return None


# --------------------------------------------------------------------------- strokes

_CAP = {"ROUND": "rnd", "SQUARE": "sq"}


def line_xml(node: dict, ctx: Ctx, nw, nh, box, opacity: float, paint: dict | None = None,
             weight: float | None = None, image_bytes=None) -> str:
    strokes = visible_paints(node.get("strokes"))
    w = float(node.get("strokeWeight", 1.0) if weight is None else weight)
    if paint is None:
        paint = strokes[-1] if strokes else None
    if paint is None or w <= 0:
        return "<a:ln><a:noFill/></a:ln>"
    kind = paint.get("type") or ""
    if kind.startswith("GRADIENT_"):
        # Lines cannot hold picture fills -> always a native gradient.
        a = float(paint.get("opacity", 1.0)) * opacity
        if kind == "GRADIENT_LINEAR":
            fill = linear_gradient_xml(paint, nw, nh, box, a)
        else:
            fill = radial_gradient_xml(dict(paint, type="GRADIENT_RADIAL"), nw, nh, box, a)
    else:
        fill = fill_xml(paint, ctx, nw, nh, box, opacity, image_bytes) or "<a:noFill/>"
    if fill.startswith("<a:blipFill"):
        fill = f"<a:solidFill>{color_xml({'r': 0.5, 'g': 0.5, 'b': 0.5}, opacity)}</a:solidFill>"
    cap = _CAP.get(node.get("strokeCap", "NONE"), "flat")
    dash = ""
    dashes = node.get("strokeDashes") or []
    if dashes:
        if len(dashes) % 2:
            dashes = dashes * 2
        ds = "".join(
            f'<a:ds d="{int(round(d / w * 100000))}" sp="{int(round(s / w * 100000))}"/>'
            for d, s in zip(dashes[0::2], dashes[1::2])
        )
        dash = f"<a:custDash>{ds}</a:custDash>"
    join = {"ROUND": "<a:round/>", "BEVEL": "<a:bevel/>"}.get(node.get("strokeJoin", "MITER"),
                                                             '<a:miter lim="800000"/>')
    return f'<a:ln w="{int(round(w * ctx.emu))}" cap="{cap}">{fill}{dash}{join}</a:ln>'


# --------------------------------------------------------------------------- effects

def effects_xml(node: dict, ctx: Ctx, opacity: float = 1.0) -> str:
    outer = inner = ""
    for e in node.get("effects") or []:
        if not e.get("visible", True):
            continue
        et = e.get("type")
        if et not in ("DROP_SHADOW", "INNER_SHADOW"):
            continue
        off = e.get("offset") or {}
        ox, oy = float(off.get("x", 0)), float(off.get("y", 0))
        dist = int(round(math.hypot(ox, oy) * ctx.emu))
        direction = int(round((math.degrees(math.atan2(oy, ox)) % 360) * 60000)) % 21600000
        blur = int(round(float(e.get("radius", 0)) * ctx.emu))
        col = color_xml(e.get("color", {"r": 0, "g": 0, "b": 0, "a": 0.25}), opacity)
        if et == "DROP_SHADOW" and not outer:
            spread = float(e.get("spread") or 0)
            scale = ""
            nw = float((node.get("size") or {}).get("x", 0))
            nh = float((node.get("size") or {}).get("y", 0))
            if spread and nw > 0 and nh > 0:
                scale = (f' sx="{int(round((nw + 2 * spread) / nw * 100000))}"'
                         f' sy="{int(round((nh + 2 * spread) / nh * 100000))}"')
            outer = (f'<a:outerShdw blurRad="{blur}" dist="{dist}" dir="{direction}"{scale} '
                     f'algn="ctr" rotWithShape="0">{col}</a:outerShdw>')
        elif et == "INNER_SHADOW" and not inner:
            inner = f'<a:innerShdw blurRad="{blur}" dist="{dist}" dir="{direction}">{col}</a:innerShdw>'
    if not (outer or inner):
        return ""
    return f"<a:effectLst>{inner}{outer}</a:effectLst>"
