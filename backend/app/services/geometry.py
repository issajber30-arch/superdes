"""Canonical plan geometry: mm units, origin top-left, y down. Validation at the trust boundary."""
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

BOUND = 100_000.0
Coord = Annotated[float, Field(ge=-BOUND, le=BOUND, allow_inf_nan=False)]
Size = Annotated[float, Field(gt=0, le=BOUND, allow_inf_nan=False)]
Id = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")]
Point = Annotated[list[Coord], Field(min_length=2, max_length=2)]
Rot = Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)]

MAX = {"walls": 500, "openings": 500, "rooms": 100, "fixtures": 500, "furniture": 1000}
ROOM_KINDS = ("living", "bedroom", "kitchen", "bathroom", "dining", "office", "hallway", "other")
WET_KINDS = ("kitchen", "bathroom")


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Wall(_M):
    id: Id
    a: Point
    b: Point
    thickness: Size = 100
    structural: bool = False


class Opening(_M):
    id: Id
    wall_id: Id
    offset: Annotated[float, Field(ge=0, le=BOUND, allow_inf_nan=False)]
    width: Size
    kind: Literal["door", "window"]


class Room(_M):
    id: Id
    name: str = Field(default="", max_length=100)
    kind: Literal[ROOM_KINDS] = "other"
    polygon: list[Point] = Field(min_length=3, max_length=200)


class Fixture(_M):
    id: Id
    kind: Literal["sink", "toilet", "shower", "bathtub", "stove", "fridge", "counter", "dishwasher", "other"]
    x: Coord
    y: Coord
    w: Size
    d: Size
    rot: Rot = 0


class Furniture(_M):
    id: Id
    catalog_key: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=100)
    x: Coord
    y: Coord
    w: Size
    d: Size
    rot: Rot = 0


def wall_length(w: Wall | dict) -> float:
    a, b = (w.a, w.b) if isinstance(w, Wall) else (w["a"], w["b"])
    return math.hypot(b[0] - a[0], b[1] - a[1])


class Geometry(_M):
    walls: list[Wall] = Field(default_factory=list, max_length=MAX["walls"])
    openings: list[Opening] = Field(default_factory=list, max_length=MAX["openings"])
    rooms: list[Room] = Field(default_factory=list, max_length=MAX["rooms"])
    fixtures: list[Fixture] = Field(default_factory=list, max_length=MAX["fixtures"])
    furniture: list[Furniture] = Field(default_factory=list, max_length=MAX["furniture"])

    @model_validator(mode="after")
    def _check(self):
        ids = [e.id for coll in (self.walls, self.openings, self.rooms, self.fixtures, self.furniture) for e in coll]
        if len(ids) != len(set(ids)):
            raise ValueError("element ids must be unique across the plan")
        walls = {}
        for w in self.walls:
            if wall_length(w) <= 0:
                raise ValueError(f"wall {w.id} has zero length")
            walls[w.id] = w
        for o in self.openings:
            w = walls.get(o.wall_id)
            if w is None:
                raise ValueError(f"opening {o.id} references unknown wall {o.wall_id}")
            if o.offset + o.width > wall_length(w) + 1e-6:
                raise ValueError(f"opening {o.id} does not fit within wall {w.id}")
        for r in self.rooms:
            if abs(polygon_area(r.polygon)) <= 0:
                raise ValueError(f"room {r.id} polygon has zero area")
        return self


def polygon_area(poly) -> float:
    """Signed shoelace area in mm^2."""
    n = len(poly)
    return sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n)) / 2


def room_area_m2(room: dict) -> float:
    return abs(polygon_area(room["polygon"])) / 1e6


def room_perimeter_m(room: dict) -> float:
    p = room["polygon"]
    return sum(math.dist(p[i], p[(i + 1) % len(p)]) for i in range(len(p))) / 1000


def bbox(poly) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_polygon(x: float, y: float, poly) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def room_of(item: dict, rooms: list[dict]) -> dict | None:
    """Room containing the item's centre (x,y is the item's top-left before rotation)."""
    cx, cy = item["x"] + item["w"] / 2, item["y"] + item["d"] / 2
    return next((r for r in rooms if point_in_polygon(cx, cy, r["polygon"])), None)


def validate(data) -> dict:
    """Raises pydantic.ValidationError; returns the normalized dict."""
    return Geometry.model_validate(data).model_dump()


EMPTY = {"walls": [], "openings": [], "rooms": [], "fixtures": [], "furniture": []}


def to_svg(geom: dict, width_px: int = 640) -> str:
    """Server-side plan drawing. All text is XML-escaped; numbers are floats from validated geometry."""
    from html import escape

    pts = [p for w in geom["walls"] for p in (w["a"], w["b"])] + [p for r in geom["rooms"] for p in r["polygon"]]
    pts += [[f["x"], f["y"]] for f in geom["furniture"] + geom["fixtures"]]
    pts += [[f["x"] + f["w"], f["y"] + f["d"]] for f in geom["furniture"] + geom["fixtures"]]
    if not pts:
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width_px} 80" width="{width_px}" height="80"><text x="10" y="45" font-size="14">Empty plan</text></svg>'
    x0, y0, x1, y1 = bbox(pts)
    pad = 500
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    w, h = max(x1 - x0, 1), max(y1 - y0, 1)
    height_px = int(width_px * h / w)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {w:.0f} {h:.0f}" '
           f'width="{width_px}" height="{height_px}" font-family="sans-serif">']
    fs = w / 45
    for r in geom["rooms"]:
        poly = " ".join(f"{p[0]:.0f},{p[1]:.0f}" for p in r["polygon"])
        fill = "#dbe9f6" if r["kind"] in WET_KINDS else "#f3efe8"
        out.append(f'<polygon points="{poly}" fill="{fill}" stroke="none"/>')
        bx0, by0, bx1, by1 = bbox(r["polygon"])
        out.append(f'<text x="{(bx0 + bx1) / 2:.0f}" y="{(by0 + by1) / 2:.0f}" font-size="{fs:.0f}" text-anchor="middle" fill="#555">'
                   f'{escape(r["name"] or r["kind"])} ({room_area_m2(r):.1f} m²)</text>')
    for f in geom["fixtures"] + geom["furniture"]:
        cx, cy = f["x"] + f["w"] / 2, f["y"] + f["d"] / 2
        out.append(f'<rect x="{f["x"]:.0f}" y="{f["y"]:.0f}" width="{f["w"]:.0f}" height="{f["d"]:.0f}" '
                   f'transform="rotate({f["rot"]:.1f} {cx:.0f} {cy:.0f})" fill="#e7d8c4" stroke="#8a7660" stroke-width="{fs / 8:.0f}"/>')
    for wl in geom["walls"]:
        color = "#222" if wl["structural"] else "#666"
        out.append(f'<line x1="{wl["a"][0]:.0f}" y1="{wl["a"][1]:.0f}" x2="{wl["b"][0]:.0f}" y2="{wl["b"][1]:.0f}" '
                   f'stroke="{color}" stroke-width="{wl["thickness"]:.0f}" stroke-linecap="square"/>')
    walls = {wl["id"]: wl for wl in geom["walls"]}
    for o in geom["openings"]:
        wl = walls[o["wall_id"]]
        L = wall_length(wl)
        ax, ay = wl["a"]
        dx, dy = (wl["b"][0] - ax) / L, (wl["b"][1] - ay) / L
        sx, sy = ax + dx * o["offset"], ay + dy * o["offset"]
        ex, ey = sx + dx * o["width"], sy + dy * o["width"]
        color = "#4a90d9" if o["kind"] == "window" else "#ffffff"
        out.append(f'<line x1="{sx:.0f}" y1="{sy:.0f}" x2="{ex:.0f}" y2="{ey:.0f}" stroke="{color}" '
                   f'stroke-width="{wl["thickness"] * 0.8:.0f}"/>')
    out.append("</svg>")
    return "".join(out)
