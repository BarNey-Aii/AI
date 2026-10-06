"""Affine transforms, SVG path parsing and DrawingML geometry builders."""

from __future__ import annotations

import math
import re

# 2x3 affine matrix: ((a, c, tx), (b, d, ty)) maps (x, y) -> (a x + c y + tx, b x + d y + ty)
Matrix = tuple[tuple[float, float, float], tuple[float, float, float]]

IDENTITY: Matrix = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))


def mat(m) -> Matrix:
    return ((float(m[0][0]), float(m[0][1]), float(m[0][2])),
            (float(m[1][0]), float(m[1][1]), float(m[1][2])))


def mul(m1: Matrix, m2: Matrix) -> Matrix:
    (a1, c1, e1), (b1, d1, f1) = m1
    (a2, c2, e2), (b2, d2, f2) = m2
    return (
        (a1 * a2 + c1 * b2, a1 * c2 + c1 * d2, a1 * e2 + c1 * f2 + e1),
        (b1 * a2 + d1 * b2, b1 * c2 + d1 * d2, b1 * e2 + d1 * f2 + f1),
    )


def translate(tx: float, ty: float) -> Matrix:
    return ((1.0, 0.0, tx), (0.0, 1.0, ty))


def apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    return (m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2])


def aabb(m: Matrix, x0: float, y0: float, w: float, h: float) -> tuple[float, float, float, float]:
    pts = [apply(m, x, y) for x, y in ((x0, y0), (x0 + w, y0), (x0, y0 + h), (x0 + w, y0 + h))]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


class Placement:
    """Unrotated box + rotation/flip in slide pixel space (DrawingML semantics)."""

    __slots__ = ("x", "y", "w", "h", "rot", "flip_h")

    def __init__(self, x, y, w, h, rot=0.0, flip_h=False):
        self.x, self.y, self.w, self.h, self.rot, self.flip_h = x, y, w, h, rot, flip_h

    def bounds(self) -> tuple[float, float, float, float]:
        if not self.rot:
            return self.x, self.y, self.w, self.h
        cx, cy = self.x + self.w / 2, self.y + self.h / 2
        r = math.radians(self.rot)
        m = ((math.cos(r), -math.sin(r), 0.0), (math.sin(r), math.cos(r), 0.0))
        bx, by, bw, bh = aabb(m, -self.w / 2, -self.h / 2, self.w, self.h)
        return cx + bx, cy + by, bw, bh


def place(m: Matrix, x0: float, y0: float, w: float, h: float) -> Placement:
    """Convert local box (x0, y0, w, h) under absolute transform ``m`` to a Placement."""
    cx, cy = apply(m, x0 + w / 2, y0 + h / 2)
    a, c = m[0][0], m[0][1]
    b, d = m[1][0], m[1][1]
    det = a * d - b * c
    flip = det < 0
    if flip:
        rot = math.degrees(math.atan2(-b, -a))
    else:
        rot = math.degrees(math.atan2(b, a))
    rot %= 360.0
    if abs(rot) < 1e-4 or abs(rot - 360) < 1e-4:
        rot = 0.0
    sx = math.hypot(a, b) or 1.0
    sy = abs(det) / sx if sx else 1.0
    w2, h2 = w * sx, h * sy
    return Placement(cx - w2 / 2, cy - h2 / 2, w2, h2, rot, flip)


# --------------------------------------------------------------------------- SVG paths

_TOKEN_RE = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")

# Segment kinds: ("M", (x, y)), ("L", (x, y)), ("C", (x1, y1, x2, y2, x, y)),
# ("Q", (x1, y1, x, y)), ("Z", ())


def parse_svg_path(d: str) -> list[tuple[str, tuple]]:
    tokens = [(m.group(1), m.group(2)) for m in _TOKEN_RE.finditer(d)]
    segs: list[tuple[str, tuple]] = []
    i = 0
    cmd = None
    cx = cy = sx = sy = 0.0
    last_ctrl = None  # (kind, x, y) for S/T reflection

    def num():
        nonlocal i
        val = float(tokens[i][1])
        i += 1
        return val

    while i < len(tokens):
        if tokens[i][0]:
            cmd = tokens[i][0]
            i += 1
            if cmd in "Zz":
                segs.append(("Z", ()))
                cx, cy = sx, sy
                last_ctrl = None
                continue
        elif cmd is None:
            i += 1
            continue
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = (cx, cy) if rel else (0.0, 0.0)
        if c == "M":
            x, y = num() + ox, num() + oy
            segs.append(("M", (x, y)))
            cx, cy = sx, sy = x, y
            cmd = "l" if rel else "L"
            last_ctrl = None
        elif c == "L":
            x, y = num() + ox, num() + oy
            segs.append(("L", (x, y)))
            cx, cy = x, y
            last_ctrl = None
        elif c == "H":
            x = num() + ox
            segs.append(("L", (x, cy)))
            cx = x
            last_ctrl = None
        elif c == "V":
            y = num() + (cy if rel else 0.0)
            segs.append(("L", (cx, y)))
            cy = y
            last_ctrl = None
        elif c == "C":
            x1, y1, x2, y2, x, y = (num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy)
            segs.append(("C", (x1, y1, x2, y2, x, y)))
            cx, cy = x, y
            last_ctrl = ("C", x2, y2)
        elif c == "S":
            x2, y2, x, y = num() + ox, num() + oy, num() + ox, num() + oy
            if last_ctrl and last_ctrl[0] == "C":
                x1, y1 = 2 * cx - last_ctrl[1], 2 * cy - last_ctrl[2]
            else:
                x1, y1 = cx, cy
            segs.append(("C", (x1, y1, x2, y2, x, y)))
            cx, cy = x, y
            last_ctrl = ("C", x2, y2)
        elif c == "Q":
            x1, y1, x, y = num() + ox, num() + oy, num() + ox, num() + oy
            segs.append(("Q", (x1, y1, x, y)))
            cx, cy = x, y
            last_ctrl = ("Q", x1, y1)
        elif c == "T":
            x, y = num() + ox, num() + oy
            if last_ctrl and last_ctrl[0] == "Q":
                x1, y1 = 2 * cx - last_ctrl[1], 2 * cy - last_ctrl[2]
            else:
                x1, y1 = cx, cy
            segs.append(("Q", (x1, y1, x, y)))
            cx, cy = x, y
            last_ctrl = ("Q", x1, y1)
        elif c == "A":
            rx, ry, phi, large, sweep = num(), num(), num(), num(), num()
            x, y = num() + ox, num() + oy
            for seg in _arc_to_cubics(cx, cy, rx, ry, phi, bool(large), bool(sweep), x, y):
                segs.append(("C", seg))
            cx, cy = x, y
            last_ctrl = None
        else:
            i += 1
    return segs


def _arc_to_cubics(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2):
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x1, y1, x2, y2, x2, y2)]
    phi = math.radians(phi_deg)
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cos_p * dx + sin_p * dy
    y1p = -sin_p * dx + cos_p * dy
    rx, ry = abs(rx), abs(ry)
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        coef = -coef
    cxp = coef * rx * y1p / ry
    cyp = -coef * ry * x1p / rx
    cx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2
    cy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = max(1, int(math.ceil(abs(dt) / (math.pi / 2))))
    step = dt / n
    out = []
    for k in range(n):
        a1 = t1 + k * step
        a2 = a1 + step
        alpha = 4 / 3 * math.tan(step / 4)

        def pt(a):
            x = rx * math.cos(a)
            y = ry * math.sin(a)
            return cos_p * x - sin_p * y + cx, sin_p * x + cos_p * y + cy

        def der(a):
            x = -rx * math.sin(a)
            y = ry * math.cos(a)
            return cos_p * x - sin_p * y, sin_p * x + cos_p * y

        p1, p2 = pt(a1), pt(a2)
        d1, d2 = der(a1), der(a2)
        out.append((p1[0] + alpha * d1[0], p1[1] + alpha * d1[1],
                    p2[0] - alpha * d2[0], p2[1] - alpha * d2[1], p2[0], p2[1]))
    return out


def segments_bbox(paths: list[list[tuple[str, tuple]]]):
    xs: list[float] = []
    ys: list[float] = []
    for segs in paths:
        for _kind, pts in segs:
            xs.extend(pts[0::2])
            ys.extend(pts[1::2])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def rounded_rect_path(w: float, h: float, radii: list[float]) -> list[tuple[str, tuple]]:
    """Rectangle with individual corner radii [tl, tr, br, bl] as bezier segments."""
    k = 0.5522847498
    lim = min(w, h) / 2
    tl, tr, br, bl = (max(0.0, min(r, lim)) for r in radii)
    s: list[tuple[str, tuple]] = [("M", (tl, 0.0)), ("L", (w - tr, 0.0))]
    if tr:
        s.append(("C", (w - tr + tr * k, 0.0, w, tr - tr * k, w, tr)))
    s.append(("L", (w, h - br)))
    if br:
        s.append(("C", (w, h - br + br * k, w - br + br * k, h, w - br, h)))
    s.append(("L", (bl, h)))
    if bl:
        s.append(("C", (bl - bl * k, h, 0.0, h - bl + bl * k, 0.0, h - bl)))
    s.append(("L", (0.0, tl)))
    if tl:
        s.append(("C", (0.0, tl - tl * k, tl - tl * k, 0.0, tl, 0.0)))
    s.append(("Z", ()))
    return s


def cust_geom_xml(paths: list[list[tuple[str, tuple]]], x0: float, y0: float, w: float, h: float,
                  emu: float, fill: bool = True, stroke: bool = True) -> str:
    """DrawingML <a:custGeom>. Path coordinates are px relative to the shape box origin."""
    pw = max(1, int(round(w * emu)))
    ph = max(1, int(round(h * emu)))

    def p(x, y):
        return f'<a:pt x="{int(round((x - x0) * emu))}" y="{int(round((y - y0) * emu))}"/>'

    attrs = ""
    if not fill:
        attrs += ' fill="none"'
    if not stroke:
        attrs += ' stroke="0"'
    out = ['<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>',
           '<a:rect l="0" t="0" r="r" b="b"/><a:pathLst>']
    for segs in paths:
        out.append(f'<a:path w="{pw}" h="{ph}"{attrs}>')
        started = False
        for kind, pts in segs:
            if kind == "M":
                out.append(f"<a:moveTo>{p(*pts)}</a:moveTo>")
                started = True
            elif not started:
                continue
            elif kind == "L":
                out.append(f"<a:lnTo>{p(*pts)}</a:lnTo>")
            elif kind == "C":
                out.append(f"<a:cubicBezTo>{p(pts[0], pts[1])}{p(pts[2], pts[3])}{p(pts[4], pts[5])}</a:cubicBezTo>")
            elif kind == "Q":
                out.append(f"<a:quadBezTo>{p(pts[0], pts[1])}{p(pts[2], pts[3])}</a:quadBezTo>")
            elif kind == "Z":
                out.append("<a:close/>")
        out.append("</a:path>")
    out.append("</a:pathLst></a:custGeom>")
    return "".join(out)


def prst_geom_xml(prst: str, adj: dict[str, int] | None = None) -> str:
    gds = "".join(f'<a:gd name="{k}" fmla="val {v}"/>' for k, v in (adj or {}).items())
    return f'<a:prstGeom prst="{prst}"><a:avLst>{gds}</a:avLst></a:prstGeom>'
