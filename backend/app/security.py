import hashlib
import secrets
import threading
import time
import uuid
from collections import deque

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .config import settings
from .errors import ApiError

_ph = PasswordHasher()
# Verified against when the email is unknown, so login timing does not reveal account existence.
_DUMMY_HASH = _ph.hash("dummy-password-for-timing")


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, hashed: str | None) -> bool:
    try:
        return _ph.verify(hashed or _DUMMY_HASH, pw) and hashed is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def create_token(user_id: uuid.UUID, ttl: int | None = None) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "iat": now, "exp": now + (ttl or settings.jwt_ttl_seconds), "typ": "session"}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> uuid.UUID | None:
    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
        if data.get("typ") != "session":
            return None
        return uuid.UUID(data["sub"])
    except (jwt.PyJWTError, ValueError):
        return None


def new_invite_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class RateLimiter:
    """shortcut: in-memory, per-process sliding window; use Redis/DB when running >1 replica."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = {}
        self.lock = threading.Lock()
        self.last_sweep = time.monotonic()

    def hit(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window
        with self.lock:
            if now - self.last_sweep > self.window:  # drop idle keys so the dict stays bounded
                self.hits = {k: q for k, q in self.hits.items() if q and q[-1] > cutoff}
                self.last_sweep = now
            q = self.hits.setdefault(key, deque())
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def reset(self):
        with self.lock:
            self.hits.clear()


login_limiter = RateLimiter(limit=10, window_s=300)  # per email
login_ip_limiter = RateLimiter(limit=50, window_s=300)  # per client IP
signup_limiter = RateLimiter(limit=20, window_s=600)  # per client IP: /auth/register + public studio join
ai_limiter = RateLimiter(limit=20, window_s=60)  # per user
LIMITERS = (login_limiter, login_ip_limiter, signup_limiter, ai_limiter)


def client_ip(request) -> str:
    # real client IP when uvicorn runs with --proxy-headers behind a trusted proxy (see railway.toml)
    return request.client.host if request.client else "?"


def limit(limiter: RateLimiter, key: str, what: str):
    if not limiter.hit(key):
        raise ApiError(429, "rate_limited", f"too many {what}, try again later")
