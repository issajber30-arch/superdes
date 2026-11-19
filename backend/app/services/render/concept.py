"""Deterministic one-point-perspective concept render (Pillow). Not photoreal; a conceptual visualization."""
import io
import math

from PIL import Image, ImageDraw, ImageFont

W, H = 1024, 640
ROOM_H = 2600.0
EYE = 1500.0


def _hex(c: str) -> tuple[int, int, int]:
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def _shade(rgb, f: float):
    return tuple(max(0, min(255, int(v * f))) for v in rgb)


FONT_CANDIDATES = ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                   "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf", "Arial.ttf")


def _font(size: int):
    """Returns (font, has_unicode). The bundled default font lacks the em dash."""
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size), True
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size), False
    except TypeError:  # Pillow without FreeType
        return ImageFont.load_default(), False


def orient(angle: str, bb):
    """Return (to_uv(x,y) -> (u,v), apparent width, apparent depth, camera u position).
    u: 0..1 left->right as seen by the viewer; v: 0 at the back wall .. 1 at the viewer's side."""
    x0, y0, x1, y1 = bb
    rw, rd = max(x1 - x0, 1), max(y1 - y0, 1)
    side = {"front": "s", "back": "n", "left": "w", "right": "e"}.get(angle, "s")
    cam_u = 0.5
    if angle.startswith("corner-"):  # e.g. 'corner-ne': camera stands in the NE corner looking across the room
        side, east = angle[7], angle[8] == "e"
        cam_u = (0.2 if east else 0.8) if side == "n" else (0.8 if east else 0.2)
    if side == "n":
        return (lambda x, y: ((x1 - x) / rw, (y1 - y) / rd)), rw, rd, cam_u
    if side == "w":
        return (lambda x, y: ((y - y0) / rd, (x1 - x) / rw)), rd, rw, cam_u
    if side == "e":
        return (lambda x, y: ((y1 - y) / rd, (x - x0) / rw)), rd, rw, cam_u
    return (lambda x, y: ((x - x0) / rw, (y - y0) / rd)), rw, rd, cam_u


class ConceptRenderer:
    name = "concept"

    def render(self, scene: dict) -> bytes:
        room = scene["room"]
        to_uv, aw, ad, cam_u = orient(scene["angle"], room["bbox"])
        cam_back = max(aw, ROOM_H) * 1.1
        f = 0.95 * (W / 2) * cam_back / (aw / 2)
        cam_x = cam_u * aw
        cx, cy = W / 2, H * 0.52

        # corner views: camera off-centre, yawed so it still looks at the middle of the back wall
        yaw = math.atan2(aw / 2 - cam_x, ad + cam_back)
        cos_t, sin_t = math.cos(yaw), math.sin(yaw)

        def P(X, Y, v):  # X along apparent width (mm), Y height (mm), v depth fraction
            dx, dz = X - cam_x, (1 - v) * ad + cam_back
            x, z = dx * cos_t - dz * sin_t, max(dx * sin_t + dz * cos_t, 1.0)
            return (cx + f * x / z, cy + f * (EYE - Y) / z)

        img = Image.new("RGB", (W, H), (235, 232, 226))
        d = ImageDraw.Draw(img)
        wall, floor = _hex(scene["wall_color"]), _hex(scene["floor_color"])
        quad = lambda pts, fill: d.polygon(pts, fill=fill, outline=_shade(fill, 0.8))
        quad([P(0, ROOM_H, 0), P(aw, ROOM_H, 0), P(aw, ROOM_H, 1), P(0, ROOM_H, 1)], _shade(wall, 1.04))  # ceiling
        quad([P(0, 0, 0), P(aw, 0, 0), P(aw, 0, 1), P(0, 0, 1)], floor)
        for i in range(1, int(ad // 600) + 1):  # floor boards / tile lines for depth cue
            v = i * 600 / ad
            d.line([P(0, 0, v), P(aw, 0, v)], fill=_shade(floor, 0.9), width=1)
        quad([P(0, 0, 0), P(0, ROOM_H, 0), P(0, ROOM_H, 1), P(0, 0, 1)], _shade(wall, 0.88))  # left wall
        quad([P(aw, 0, 0), P(aw, ROOM_H, 0), P(aw, ROOM_H, 1), P(aw, 0, 1)], _shade(wall, 0.92))  # right wall
        quad([P(0, 0, 0), P(aw, 0, 0), P(aw, ROOM_H, 0), P(0, ROOM_H, 0)], wall)  # back wall

        tol = 0.04
        for o in scene["openings"]:
            (ua, va), (ub, vb) = to_uv(*o["a"]), to_uv(*o["b"])
            y_lo, y_hi = (900, 2100) if o["kind"] == "window" else (0, 2100)
            fill = (170, 205, 230) if o["kind"] == "window" else (150, 110, 75)
            if va < tol and vb < tol:
                pts = [P(ua * aw, y_lo, 0), P(ub * aw, y_lo, 0), P(ub * aw, y_hi, 0), P(ua * aw, y_hi, 0)]
            elif ua < tol and ub < tol:
                pts = [P(0, y_lo, va), P(0, y_lo, vb), P(0, y_hi, vb), P(0, y_hi, va)]
            elif ua > 1 - tol and ub > 1 - tol:
                pts = [P(aw, y_lo, va), P(aw, y_lo, vb), P(aw, y_hi, vb), P(aw, y_hi, va)]
            else:
                continue  # wall behind the viewer
            d.polygon(pts, fill=fill, outline=(90, 90, 90))

        accent, base = _hex(scene["accent_color"]), _hex(scene["furniture_color"])
        boxes = []
        for i, it in enumerate(scene["furniture"]):
            cxm, cym = it["x"] + it["w"] / 2, it["y"] + it["d"] / 2
            r = math.radians(it["rot"])
            corners = []
            for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                px, py = dx * it["w"] / 2, dy * it["d"] / 2
                u, v = to_uv(cxm + px * math.cos(r) - py * math.sin(r), cym + px * math.sin(r) + py * math.cos(r))
                corners.append((u * aw, min(max(v, 0), 1)))
            depth = sum(1 - c[1] for c in corners) / 4
            boxes.append((depth, i, corners, it["h"], accent if i % 3 == 0 else base))
        for _, _, corners, h, color in sorted(boxes, key=lambda b: (-b[0], b[1])):  # far to near
            faces = []
            for k in range(4):
                (xa, va), (xb, vb) = corners[k], corners[(k + 1) % 4]
                faces.append(((va + vb) / 2, [P(xa, 0, va), P(xb, 0, vb), P(xb, h, vb), P(xa, h, va)]))
            for j, (_, pts) in enumerate(sorted(faces, key=lambda t: t[0])):
                d.polygon(pts, fill=_shade(color, 0.75 + 0.07 * j), outline=_shade(color, 0.55))
            d.polygon([P(x, h, v) for x, v in corners], fill=_shade(color, 1.12), outline=_shade(color, 0.55))

        d.rectangle([0, H - 44, W, H], fill=(30, 30, 30))
        font, uni = _font(18)
        dash, dot = ("—", "·") if uni else ("-", "|")
        d.text((16, H - 34), f"Conceptual visualization {dash} plan v{scene['version_no']}", fill=(255, 255, 255), font=font)
        d.text((W - 16, H - 34), f"{scene['room_label']} {dot} {scene['style_name']} {dot} {scene['angle']}", fill=(200, 200, 200),
               font=_font(16)[0], anchor="ra")
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()
