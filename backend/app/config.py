import os
import pathlib
from dataclasses import dataclass, field

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent

PROFESSIONAL_CAVEAT = (
    "Conceptual design only - not approved for construction. Structural, load-bearing, plumbing, "
    "electrical, ventilation and building-code matters require review by a qualified professional "
    "before any work is carried out."
)
ESTIMATE_BASIS = "generic estimate, not a retailer price"
ESTIMATE_DISCLAIMER = (
    "Estimates are non-binding ranges based on generic catalog data. Actual prices depend on "
    "retailer, region, quantities and installation."
)


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    env: str = field(default_factory=lambda: os.environ.get("ENV", "dev"))
    database_url: str = field(default_factory=lambda: os.environ.get(
        "DATABASE_URL", "postgresql://app_user:app_user_dev@localhost:5432/superdes_dev"))
    jwt_secret: str = field(default_factory=lambda: os.environ.get("JWT_SECRET", ""))
    jwt_ttl_seconds: int = field(default_factory=lambda: int(os.environ.get("JWT_TTL_SECONDS", "3600")))
    cookie_name: str = "sd_session"
    cookie_secure: bool = field(default_factory=lambda: _bool("COOKIE_SECURE", True))
    cookie_samesite: str = field(default_factory=lambda: os.environ.get("COOKIE_SAMESITE", "lax").lower())
    frontend_origins: list[str] = field(default_factory=lambda: [
        o.strip().rstrip("/") for o in os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173").split(",") if o.strip()])
    upload_dir: pathlib.Path = field(default_factory=lambda: pathlib.Path(
        os.environ.get("UPLOAD_DIR", str(BACKEND_DIR / "data" / "uploads"))))
    supabase_url: str = field(default_factory=lambda: os.environ.get("SUPABASE_URL", "").rstrip("/"))
    supabase_service_key: str = field(default_factory=lambda: os.environ.get("SUPABASE_SERVICE_KEY", ""))
    supabase_bucket: str = field(default_factory=lambda: os.environ.get("SUPABASE_BUCKET", "superdes"))
    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "").rstrip("/"))
    ollama_model: str = field(default_factory=lambda: os.environ.get("OLLAMA_MODEL", "llama3.1"))
    ollama_api_key: str = field(default_factory=lambda: os.environ.get("OLLAMA_API_KEY", ""))
    comfyui_url: str = field(default_factory=lambda: os.environ.get("COMFYUI_URL", "").rstrip("/"))
    render_worker: bool = field(default_factory=lambda: _bool("RENDER_WORKER", True))
    render_poll_seconds: float = field(default_factory=lambda: float(os.environ.get("RENDER_POLL_SECONDS", "2")))
    currency: str = field(default_factory=lambda: os.environ.get("CURRENCY", "EUR"))
    render_client_quota: int = field(default_factory=lambda: int(os.environ.get("RENDER_CLIENT_QUOTA", "5")))
    preview_mode: bool = field(default_factory=lambda: _bool("PREVIEW_MODE", False))
    trial_credits: int = 50
    max_upload_bytes: int = 10 * 1024 * 1024

    @property
    def is_prod(self) -> bool:
        return self.env in ("prod", "production")

    def __post_init__(self):
        if self.cookie_samesite not in ("lax", "strict", "none"):
            raise RuntimeError("COOKIE_SAMESITE must be lax, strict or none")
        if self.is_prod:
            for name in ("DATABASE_URL", "FRONTEND_ORIGIN"):
                if not os.environ.get(name, "").strip():
                    raise RuntimeError(f"{name} must be set explicitly in prod")
            if len(self.jwt_secret) < 32:
                raise RuntimeError("JWT_SECRET (>=32 chars) is required in prod")
            if not self.cookie_secure:
                raise RuntimeError("COOKIE_SECURE must be on in prod")
        elif not self.jwt_secret:
            self.jwt_secret = "dev-only-insecure-secret-change-me-0000000000"


settings = Settings()
