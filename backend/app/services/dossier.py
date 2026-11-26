"""Branded, print-friendly HTML dossier snapshot (Jinja autoescape ON; images embedded as data: URIs)."""
import base64
import binascii
import io
from datetime import datetime, timezone

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup
from PIL import Image

from ..errors import ApiError
from ..config import BACKEND_DIR, ESTIMATE_BASIS, ESTIMATE_DISCLAIMER, PROFESSIONAL_CAVEAT
from . import storage
from .estimates import compute as compute_estimate
from .geometry import to_svg

env = Environment(loader=FileSystemLoader(BACKEND_DIR / "app" / "templates"), autoescape=select_autoescape(["html"]))
FONT_STACKS = {"inter": "Inter, Helvetica, Arial, sans-serif", "lora": "Lora, Georgia, serif",
               "playfair": "'Playfair Display', Georgia, serif", "source-sans": "'Source Sans 3', Arial, sans-serif",
               "roboto": "Roboto, Arial, sans-serif", "merriweather": "Merriweather, Georgia, serif",
               "system": "system-ui, sans-serif"}
CSP = ("default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'self'")


def _data_uri(storage_key: str, max_px: int) -> str | None:
    try:
        raw = storage.get_storage().get(storage_key)
        with Image.open(io.BytesIO(raw)) as im:
            if storage.too_many_pixels(*im.size):
                return None
            im = im.convert("RGB")
            im.thumbnail((max_px, max_px))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=82)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


VIEW_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,")


def view_images(urls: list[str]) -> list[str]:
    """3D snapshots sent by the browser: PNG/JPEG data URLs only, decoded by Pillow, re-encoded as JPEG <= 1200 px."""
    out = []
    for i, url in enumerate(urls):
        prefix = next((p for p in VIEW_PREFIXES if url.startswith(p)), None)
        if not prefix:
            raise ApiError(422, "validation_error", f"views[{i}] must be a PNG or JPEG data URL")
        try:
            raw = base64.b64decode(url[len(prefix):], validate=True)
            with Image.open(io.BytesIO(raw)) as im:
                if im.format not in ("PNG", "JPEG") or storage.too_many_pixels(*im.size):
                    raise ValueError("format or size")
                im = im.convert("RGB")
                im.thumbnail((1200, 1200))
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=85)
        except (binascii.Error, ValueError, OSError, Image.DecompressionBombError):
            raise ApiError(422, "validation_error", f"views[{i}] is not a valid image") from None
        out.append("data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode())
    return out


def build_html(conn, studio_id, project: dict, version: dict, note: str, author: dict, views: list[str] | None = None) -> str:
    from ..routers.briefs import load_brief

    branding = conn.execute("select b.*, s.slug, s.name as studio_name from studio_branding b join studios s on s.id = b.studio_id "
                            "where b.studio_id = %s", (studio_id,)).fetchone()
    logo = conn.execute("select storage_key from uploads where id = %s", (branding["logo_upload_id"],)).fetchone() \
        if branding["logo_upload_id"] else None
    alternatives = conn.execute("select a.name, a.description, a.style_key, v.version_no from design_alternatives a "
                                "join plan_versions v on v.id = a.plan_version_id where a.project_id = %s order by a.created_at",
                                (project["id"],)).fetchall()
    renders = conn.execute("select j.view, v.version_no, u.storage_key from render_jobs j join plan_versions v on v.id = j.plan_version_id "
                           "join uploads u on u.id = j.result_upload_id where j.project_id = %s and j.status = 'succeeded' "
                           "order by j.created_at desc limit 6", (project["id"],)).fetchall()
    return env.get_template("dossier.html").render(
        branding=branding, font_stack=FONT_STACKS.get(branding["font"], FONT_STACKS["system"]),
        logo=_data_uri(logo["storage_key"], 300) if logo else None,
        project=project, version=version, note=note, author=author, views=views or [],
        plan_svg=Markup(to_svg(version["geometry"])),  # generated server-side; all text inside is escaped
        brief=load_brief(conn, project["id"]), alternatives=alternatives,
        renders=[{"view": r["view"], "version_no": r["version_no"], "src": _data_uri(r["storage_key"], 480)} for r in renders],
        estimate=compute_estimate(conn, project["id"]), basis=ESTIMATE_BASIS, disclaimer=ESTIMATE_DISCLAIMER,
        caveat=PROFESSIONAL_CAVEAT, generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
