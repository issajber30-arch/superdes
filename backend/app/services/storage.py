"""Object storage. Keys always start with the studio_id and are generated server-side.
Local disk in dev; Supabase Storage (REST via httpx) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set."""
import io
import pathlib
import re
import uuid

import httpx
from PIL import Image, UnidentifiedImageError

from ..config import settings
from ..errors import ApiError

_KEY_RE = re.compile(r"^[0-9a-f-]{36}/[A-Za-z0-9_-]+/[0-9a-f-]{36}\.(png|jpg|webp|gif)$")
FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp"),
           "GIF": ("gif", "image/gif")}
Image.MAX_IMAGE_PIXELS = 40_000_000  # decompression-bomb guard


class LocalStorage:
    def __init__(self, base: pathlib.Path):
        self.base = base

    def _path(self, key: str) -> pathlib.Path:
        if not _KEY_RE.match(key):
            raise ValueError("invalid storage key")
        return self.base / key

    def put(self, key: str, data: bytes, content_type: str):
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class SupabaseStorage:
    def __init__(self, url: str, key: str, bucket: str):
        self.url, self.bucket = url, bucket
        self.headers = {"Authorization": f"Bearer {key}", "apikey": key}

    def put(self, key: str, data: bytes, content_type: str):
        if not _KEY_RE.match(key):
            raise ValueError("invalid storage key")
        r = httpx.post(f"{self.url}/storage/v1/object/{self.bucket}/{key}", content=data, timeout=30,
                       headers={**self.headers, "Content-Type": content_type, "x-upsert": "true"})
        r.raise_for_status()

    def get(self, key: str) -> bytes:
        if not _KEY_RE.match(key):
            raise ValueError("invalid storage key")
        r = httpx.get(f"{self.url}/storage/v1/object/authenticated/{self.bucket}/{key}", headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.content


def get_storage():
    if settings.supabase_url and settings.supabase_service_key:
        return SupabaseStorage(settings.supabase_url, settings.supabase_service_key, settings.supabase_bucket)
    return LocalStorage(settings.upload_dir)


def too_many_pixels(w: int, h: int) -> bool:
    """Pillow only warns (DecompressionBombWarning) between 1x and 2x MAX_IMAGE_PIXELS; treat that as an error.
    Checked explicitly instead of via warnings filters, which are process-global and not thread-safe."""
    return w * h > Image.MAX_IMAGE_PIXELS


def inspect_image(data: bytes) -> tuple[str, str, int, int]:
    """Verify bytes are a real image in an allowed format. Returns (ext, content_type, w, h)."""
    if not data:
        raise ApiError(400, "invalid_image", "empty file")
    if len(data) > settings.max_upload_bytes:
        raise ApiError(413, "too_large", "image exceeds 10 MB")
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = im.format
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise ApiError(400, "invalid_image", "file is not a valid image")
    if too_many_pixels(w, h):
        raise ApiError(400, "invalid_image", "image dimensions are too large")
    if fmt not in FORMATS:
        raise ApiError(400, "invalid_image", "allowed formats: PNG, JPEG, WEBP, GIF")
    ext, ctype = FORMATS[fmt]
    return ext, ctype, w, h


def store_image(conn, studio_id, project_id, user_id, data: bytes, kind: str, filename: str = "") -> dict:
    ext, ctype, w, h = inspect_image(data)
    key = f"{studio_id}/{project_id or 'studio'}/{uuid.uuid4()}.{ext}"
    get_storage().put(key, data, ctype)
    return conn.execute(
        "insert into uploads (studio_id, project_id, kind, storage_key, content_type, size_bytes, width, height, filename, uploaded_by) "
        "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id, project_id, kind, content_type, size_bytes, width, height, filename, created_at",
        (studio_id, project_id, kind, key, ctype, len(data), w, h, filename[:200], user_id)).fetchone()


def image_response(storage_key: str, content_type: str):
    from fastapi import Response

    try:
        data = get_storage().get(storage_key)
    except (OSError, httpx.HTTPError, ValueError):
        raise ApiError(404, "not_found", "file not found")
    return Response(data, media_type=content_type, headers={
        "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox"})
