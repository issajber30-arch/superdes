"""Apply supabase/migrations/*.sql in order using DATABASE_ADMIN_URL; tracks files in schema_migrations.

Usage: DATABASE_ADMIN_URL=postgresql://... [APP_USER_PASSWORD=...] python scripts/migrate.py [--reset]
--reset drops and recreates schema public first (dev/test only).
"""
import os
import pathlib
import sys

import psycopg

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def migrate(admin_url: str, reset: bool = False, app_password: str | None = None) -> list[str]:
    applied_now = []
    with psycopg.connect(admin_url, autocommit=True) as conn:
        if reset:
            conn.execute("drop schema if exists public cascade")
            conn.execute("create schema public")
        conn.execute(
            "create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())"
        )
        done = {r[0] for r in conn.execute("select filename from schema_migrations")}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name in done:
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute("insert into schema_migrations (filename) values (%s)", (path.name,))
            applied_now.append(path.name)
        if app_password:
            # utility statements cannot take server-side params; ClientCursor quotes the literal safely
            psycopg.ClientCursor(conn).execute("alter role app_user password %s", (app_password,))
    return applied_now


if __name__ == "__main__":
    url = os.environ.get("DATABASE_ADMIN_URL")
    if not url:
        sys.exit("DATABASE_ADMIN_URL is required")
    names = migrate(url, reset="--reset" in sys.argv, app_password=os.environ.get("APP_USER_PASSWORD"))
    print("applied:", ", ".join(names) if names else "(nothing new)")
