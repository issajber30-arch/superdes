import uuid

from psycopg.types.json import Jsonb

from ..errors import ApiError, not_found
from . import audit
from .review_flags import compute_flags

VERSION_COLS = ("id, version_no, author_id, author_role, label, review_status, review_flags, reviewed_by, "
                "reviewed_at, created_at")


def create_project(ctx, name: str, geometry: dict | None) -> dict:
    pid = uuid.uuid4()
    # insert without RETURNING: a client creator can only read the row after its grant exists
    ctx.conn.execute("insert into projects (id, studio_id, name, created_by) values (%s,%s,%s,%s)",
                     (pid, ctx.studio_id, name, ctx.user_id))
    if not ctx.is_staff:
        ctx.conn.execute("insert into project_permissions (studio_id, project_id, user_id) values (%s,%s,%s)",
                         (ctx.studio_id, pid, ctx.user_id))
    ctx.conn.execute("insert into floor_plans (studio_id, project_id) values (%s,%s)", (ctx.studio_id, pid))
    ctx.conn.execute("insert into briefs (studio_id, project_id, updated_by) values (%s,%s,%s)", (ctx.studio_id, pid, ctx.user_id))
    project = ctx.conn.execute("select * from projects where id = %s", (pid,)).fetchone()
    audit.log(ctx.conn, "project.create", ctx.studio_id, ctx.user_id, "project", pid, {"name": name})
    save_version(ctx, project, geometry or {"walls": [], "openings": [], "rooms": [], "fixtures": [], "furniture": []},
                 "initial")
    return project


def get_plan(conn, project_id) -> dict:
    plan = conn.execute("select * from floor_plans where project_id = %s", (project_id,)).fetchone()
    if not plan:
        raise not_found("plan")
    return plan


def current_version(conn, project_id, with_geometry=True) -> dict | None:
    plan = get_plan(conn, project_id)
    if not plan["current_version_id"]:
        return None
    cols = VERSION_COLS + (", geometry" if with_geometry else "")
    return conn.execute(f"select {cols} from plan_versions where id = %s", (plan["current_version_id"],)).fetchone()


def get_version(conn, project_id, version_no: int, with_geometry=True) -> dict:
    cols = VERSION_COLS + (", geometry" if with_geometry else "")
    row = conn.execute(f"select {cols} from plan_versions where project_id = %s and version_no = %s",
                       (project_id, version_no)).fetchone()
    if not row:
        raise not_found("plan version")
    return row


def save_version(ctx, project: dict, geometry: dict, label: str, base_version_no: int | None = None) -> dict:
    conn = ctx.conn
    plan = conn.execute("select * from floor_plans where project_id = %s for update", (project["id"],)).fetchone()
    prev = None
    if plan["current_version_id"]:
        prev = conn.execute("select version_no, geometry, review_status, review_flags from plan_versions where id = %s",
                            (plan["current_version_id"],)).fetchone()
    if base_version_no is not None and prev and prev["version_no"] != base_version_no:
        raise ApiError(409, "version_conflict", "plan changed since you loaded it",
                       {"current_version_no": prev["version_no"]})
    flags = compute_flags(prev["geometry"] if prev else None, geometry)
    if prev and prev["review_status"] == "provisional":
        # unreviewed flags carry forward until a designer reviews
        flags = [dict(f, carried_from=f.get("carried_from", prev["version_no"])) for f in prev["review_flags"]] + flags
    version_no = (prev["version_no"] + 1) if prev else 1
    row = conn.execute(
        "insert into plan_versions (studio_id, project_id, plan_id, version_no, geometry, author_id, author_role, label, "
        f"review_status, review_flags) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning {VERSION_COLS}, geometry",
        (ctx.studio_id, project["id"], plan["id"], version_no, Jsonb(geometry), ctx.user_id, ctx.role, label,
         "provisional" if flags else "conceptual", Jsonb(flags))).fetchone()
    conn.execute("update floor_plans set current_version_id = %s where id = %s", (row["id"], plan["id"]))
    audit.log(conn, "plan.version_save", ctx.studio_id, ctx.user_id, "plan_version", row["id"],
              {"project_id": str(project["id"]), "version_no": version_no, "flags": len(flags)})
    return row
