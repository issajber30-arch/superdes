from typing import Annotated, Literal

from fastapi import APIRouter, File, UploadFile
from pydantic import Field

from ..config import settings
from ..deps import AnonCtx, MemberCtx, OwnerCtx
from ..errors import not_found, preview_closed
from ..schemas import Name, Strict
from ..services import audit, storage
from .studios import Slug, _public_studio

router = APIRouter(tags=["branding"])

Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
FONTS = ("inter", "lora", "playfair", "source-sans", "roboto", "merriweather", "system")
TEMPLATES = ("classic", "modern", "minimal")


class BrandingUpdate(Strict):
    display_name: Name | None = None
    primary_color: Color | None = None
    accent_color: Color | None = None
    background_color: Color | None = None
    font: Literal[FONTS] | None = None
    template: Literal[TEMPLATES] | None = None


BRANDING_COLS = "display_name, logo_upload_id, primary_color, accent_color, background_color, font, template, updated_at"


# ---------- branding ----------
@router.get("/studio/branding")
def get_branding(ctx: MemberCtx):
    return ctx.conn.execute(f"select {BRANDING_COLS} from studio_branding where studio_id = %s", (ctx.studio_id,)).fetchone()


@router.put("/studio/branding")
def update_branding(body: BrandingUpdate, ctx: OwnerCtx):
    changes = body.model_dump(exclude_none=True)
    current = ctx.conn.execute("select * from studio_branding where studio_id = %s", (ctx.studio_id,)).fetchone()
    merged = {k: changes.get(k, current[k]) for k in
              ("display_name", "primary_color", "accent_color", "background_color", "font", "template")}
    row = ctx.conn.execute(
        "update studio_branding set display_name=%(display_name)s, primary_color=%(primary_color)s, accent_color=%(accent_color)s, "
        "background_color=%(background_color)s, font=%(font)s, template=%(template)s, updated_at=now() "
        f"where studio_id=%(sid)s returning {BRANDING_COLS}", {**merged, "sid": ctx.studio_id}).fetchone()
    audit.log(ctx.conn, "branding.update", ctx.studio_id, ctx.user_id, "studio", ctx.studio_id, changes)
    return row


@router.post("/studio/branding/logo")
def upload_logo(ctx: OwnerCtx, file: UploadFile = File(...)):
    data = file.file.read(settings.max_upload_bytes + 1)
    up = storage.store_image(ctx.conn, ctx.studio_id, None, ctx.user_id, data, "logo", file.filename or "")
    row = ctx.conn.execute(f"update studio_branding set logo_upload_id=%s, updated_at=now() where studio_id=%s "
                           f"returning {BRANDING_COLS}", (up["id"], ctx.studio_id)).fetchone()
    audit.log(ctx.conn, "branding.logo", ctx.studio_id, ctx.user_id, "upload", up["id"])
    return row


@router.get("/studio/branding/logo")
def get_logo(ctx: MemberCtx):
    row = ctx.conn.execute("select u.storage_key, u.content_type from studio_branding b join uploads u on u.id = b.logo_upload_id "
                           "where b.studio_id = %s", (ctx.studio_id,)).fetchone()
    if not row:
        raise not_found("logo")
    return storage.image_response(row["storage_key"], row["content_type"])


@router.get("/public/studios/{slug}")
def public_studio(slug: Slug, ctx: AnonCtx):
    if settings.preview_mode:  # only the client join page (#/s/{slug}) uses this
        raise preview_closed()
    row = _public_studio(ctx, slug)
    row.pop("studio_id")
    row["logo_url"] = f"/public/studios/{slug}/logo" if row.pop("has_logo") else None
    return row


@router.get("/public/studios/{slug}/logo")
def public_logo(slug: Slug, ctx: AnonCtx):
    row = ctx.conn.execute("select * from studio_public_logo(%s)", (slug,)).fetchone()
    if not row:
        raise not_found("logo")
    return storage.image_response(row["storage_key"], row["content_type"])
